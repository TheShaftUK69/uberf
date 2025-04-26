import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mysql from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
console.log('Environment loaded');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
const PORT = process.env.PORT || 3001;
const POOL_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'uberf',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30000,
};

console.log(`Server initializing on port ${PORT}`);

// Server setup
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

console.log('Socket.IO server created');

// Middleware
app.use(express.static(path.join(__dirname, '../build')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Database setup
console.log('Initializing database connection pool...');
const pool = mysql.createPool(POOL_CONFIG);
console.log('Database pool created');

// Database helper functions
const db = {
  async query(sql, params = []) {
    console.log(`Executing query: ${sql}`, params);
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute(sql, params);
      console.log(`Query completed, returned ${Array.isArray(rows) ? rows.length : 1} results`);
      return rows;
    } catch (error) {
      console.error('Database query error:', error);
      throw error;
    } finally {
      connection.release();
      console.log('Database connection released');
    }
  },

  async updateUserStatus(userID, status) {
    console.log(`Updating user ${userID} status to: ${status}`);
    return this.query('UPDATE users SET status = ? WHERE userID = ?', [status, userID]);
  },

  async updateUserSuspension(userID, suspended) {
    console.log(`Updating user ${userID} suspension status to: ${suspended}`);
    return this.query('UPDATE users SET suspended = ? WHERE userID = ?', [suspended, userID]);
  },

  async getAllUsers() {
    console.log('Fetching all users with coordinates');
    return this.query(`
      SELECT u.*, c.lat, c.lng
      FROM users u
      LEFT JOIN coords c ON u.id = c.userID
	  LIMIT 9
    `);
  }
};

// Socket state management
const socketManager = {
  userSockets: new Map(),

  registerUser(userID, socketID) {
    console.log(`Registering user ${userID} with socket ${socketID}`);
    this.userSockets.set(userID, socketID);
    const users = this.getConnectedUsers();
    console.log('Currently connected users:', users);
    return users;
  },

  removeUser(socketID) {
    console.log(`Removing user with socket ${socketID}`);
    const userID = this.getUserBySocket(socketID);
    if (userID) {
      this.userSockets.delete(userID);
      console.log(`User ${userID} removed from socket mapping`);
      return userID;
    }
    console.log('No user found for socket ID');
    return null;
  },

  getUserSocket(userID) {
    const socketID = this.userSockets.get(userID);
    console.log(`Looking up socket for user ${userID}: ${socketID}`);
    return socketID;
  },

  getUserBySocket(socketID) {
    console.log(`Looking up user for socket ${socketID}`);
    for (const [userID, sock] of this.userSockets.entries()) {
      if (sock === socketID) {
        console.log(`Found user ${userID} for socket ${socketID}`);
        return userID;
      }
    }
    console.log('No user found for socket');
    return null;
  },

  getConnectedUsers() {
    const users = Array.from(this.userSockets.keys());
    console.log('Getting connected users:', users);
    return users;
  }
};

// Socket event handlers
const socketHandlers = {
  async handleGetAllUsers(socket) {
    console.log(`Fetching all users for socket ${socket.id}`);
    try {
      const users = await db.getAllUsers();
      console.log(`Sending ${users.length} users to requesting client only`);
      // Changed from io.emit to socket.emit to send only to the requesting client
      socket.emit('allUsers', users);
    } catch (error) {
      console.error('Error in handleGetAllUsers:', error);
      socket.emit('error', { message: 'Failed to fetch users' });
    }
  },

  async handleStatusUpdate(socket, { userID, newStatus }) {
    console.log(`Status update request for user ${userID} to ${newStatus}`);
    try {
      if (newStatus === 'suspend' || newStatus === 'unsuspend') {
        const suspended = newStatus === 'suspend' ? 1 : 0;
        console.log(`Processing suspension update for user ${userID}`);
        await db.updateUserSuspension(userID, suspended);
        io.emit('updateField', { userID, updatedField: 'suspended', newValue: suspended });
      } else {
        console.log(`Processing status update for user ${userID}`);
        await db.updateUserStatus(userID, newStatus);
        io.emit('updateField', { userID, updatedField: 'status', newValue: newStatus });
      }
      console.log('Status update completed successfully');
    } catch (error) {
      console.error('Error in handleStatusUpdate:', error);
      socket.emit('error', { message: 'Failed to update status' });
    }
  },

  handlePrivateMessage(socket, { toUserID, message }) {
    console.log(`Private message from ${socket.id} to user ${toUserID}`);
    const recipientSocketId = socketManager.getUserSocket(toUserID);
    if (recipientSocketId) {
      console.log(`Sending private message to socket ${recipientSocketId}`);
      io.to(recipientSocketId).emit('privateMessage', { from: socket.id, message });
    } else {
      console.log(`Recipient ${toUserID} not online, message not delivered`);
      socket.emit('error', { message: `User ${toUserID} is not online` });
    }
  },

  async handleGoLive(socket, { userID }) {
    console.log(`Go live request for user ${userID}`);
    try {
      await db.updateUserStatus(userID, 'live');
      console.log(`User ${userID} is now live`);
      io.emit('updateField', { userID, updatedField: 'status', newValue: 'live' });
    } catch (error) {
      console.error('Error in handleGoLive:', error);
      socket.emit('error', { message: 'Failed to go live' });
    }
  }
};

// Debug endpoints
app.get('/debug/users', (req, res) => {
  console.log('Debug endpoint accessed - returning active users');
  res.json({
    activeUsers: Object.fromEntries(socketManager.userSockets),
    count: socketManager.userSockets.size
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);

  socket.on('registerUser', (userID) => {
    console.log(`Registration request for user ${userID}`);
    socketManager.registerUser(userID, socket.id);
    io.emit('updateField', { userID, updatedField: 'status', newValue: 'online' });
    console.log(`User ${userID} registered and marked as online`);
  });

  socket.on('getAllUsers', () => {
    console.log(`getAllUsers request from socket ${socket.id}`);
    socketHandlers.handleGetAllUsers(socket);
  });
  
  socket.on('updateStatus', (data) => {
    console.log(`updateStatus request from socket ${socket.id}`, data);
    socketHandlers.handleStatusUpdate(socket, data);
  });
  
  socket.on('sendPrivateMessage', (data) => {
    console.log(`sendPrivateMessage request from socket ${socket.id}`, data);
    socketHandlers.handlePrivateMessage(socket, data);
  });
  
  socket.on('gonelive', (data) => {
    console.log(`gonelive request from socket ${socket.id}`, data);
    socketHandlers.handleGoLive(socket, data);
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    const userID = socketManager.removeUser(socket.id);
    if (userID) {
      console.log(`User ${userID} marked as offline`);
      io.emit('updateField', { userID, updatedField: 'status', newValue: 'offline' });
    }
  });
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Ready to accept connections');
});
