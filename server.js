import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import './firebase.js';
import './mongo.js';

import telemedicineRoutes from './routes/telemedicine.routes.js';
import agoraRoutes from './routes/agora.routes.js';
import patientNotesRoutes from './routes/patient_notes.routes.js';
import prescriptionsRoutes from './routes/prescriptions.routes.js';
import labRoutes from './routes/lab.routes.js';
import healthRoutes from './routes/health.routes.js';

const app = express();

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Compression middleware
app.use(compression());

// CORS configuration
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Body parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Health check routes
app.use('/health', healthRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    ok: true, 
    service: 'homecare-pro-api',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// API routes
app.use('/telemedicine', telemedicineRoutes);
app.use('/agora', agoraRoutes);
app.use('/patients', patientNotesRoutes);
app.use('/patients', prescriptionsRoutes);
app.use('/patients', labRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    path: req.path,
    message: 'The requested resource does not exist'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  
  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

export default app;
