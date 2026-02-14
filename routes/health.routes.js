import express from 'express';
import { dbPromise } from '../mongo.js';
import admin from '../firebase.js';

const router = express.Router();

/**
 * Basic health check
 */
router.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'homecare-pro-api',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

/**
 * Detailed health check with dependency status
 */
router.get('/detailed', async (req, res) => {
  const health = {
    status: 'healthy',
    service: 'homecare-pro-api',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dependencies: {
      mongodb: { status: 'unknown' },
      firebase: { status: 'unknown' }
    }
  };

  // Check MongoDB
  try {
    const db = await dbPromise;
    await db.admin().ping();
    health.dependencies.mongodb = { 
      status: 'healthy',
      message: 'Connected' 
    };
  } catch (error) {
    health.status = 'degraded';
    health.dependencies.mongodb = { 
      status: 'unhealthy',
      error: error.message 
    };
  }

  // Check Firebase
  try {
    await admin.firestore().collection('_health_check').limit(1).get();
    health.dependencies.firebase = { 
      status: 'healthy',
      message: 'Connected' 
    };
  } catch (error) {
    health.status = 'degraded';
    health.dependencies.firebase = { 
      status: 'unhealthy',
      error: error.message 
    };
  }

  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * Readiness check for Kubernetes/container orchestration
 */
router.get('/ready', async (req, res) => {
  try {
    // Quick check that critical services are available
    const db = await dbPromise;
    await db.admin().ping();
    
    res.json({ ready: true });
  } catch (error) {
    res.status(503).json({ 
      ready: false,
      error: error.message 
    });
  }
});

/**
 * Liveness check for Kubernetes/container orchestration
 */
router.get('/live', (req, res) => {
  res.json({ alive: true });
});

export default router;
