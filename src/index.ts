import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import config from './config/index.js';

// Import routes
import cardsRoutes from './routes/cards.js';
import ordersRoutes from './routes/orders.js';
import adminRoutes from './routes/admin.js';
import checkoutRoutes from './routes/checkout.js';
import bundlesRoutes from './routes/bundles.js';
import customCardsRoutes from './routes/customCards.js';

const app = express();

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS - Allow frontend URL and localhost for development
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      config.frontendUrl,
      'http://localhost:5173',
      'http://localhost:3000',
      'https://mtg-proxy-five.vercel.app',
      'https://stridersforge.combatcoders.io',
      'https://stridersforge.com',
      'http://www.stridersforge.com',
      'https://www.stridersforge.com',
    ].filter(Boolean); // Remove any undefined/null values
    
    if (allowedOrigins.includes(origin) || config.nodeEnv === 'development') {
      callback(null, true);
    } else {
      console.warn(`CORS blocked origin: ${origin}`);
      callback(null, false);
    }
  },
  credentials: true,
}));

// Logging
app.use(morgan('combined'));

// Stripe webhook needs raw body
app.use('/api/checkout/webhook', express.raw({ type: 'application/json' }));

// JSON parsing for other routes
app.use(express.json());

// Ensure data directories exist
if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}
if (!fs.existsSync(config.cardImagesDir)) {
  fs.mkdirSync(config.cardImagesDir, { recursive: true });
}

// Serve static card images
app.use('/images', express.static(config.dataDir, {
  maxAge: '7d',
  etag: true,
}));

// API Routes
app.use('/api/cards', cardsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/bundles', bundlesRoutes);
app.use('/api/custom-cards', customCardsRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(config.port, () => {
  console.log(`
  🚀 Striders Forge Backend Server
  ============================
  Port: ${config.port}
  Environment: ${config.nodeEnv}
  Frontend URL: ${config.frontendUrl}
  Data Directory: ${config.dataDir}
  
  API Endpoints:
  - GET  /api/health
  - GET  /api/cards
  - GET  /api/cards/sets
  - GET  /api/cards/search
  - GET  /api/cards/:id
  - GET  /api/orders/track/:trackingCode
  - POST /api/checkout/create-session
  - POST /api/checkout/webhook
  - GET  /api/checkout/pricing
  - POST /api/admin/login
  - GET  /api/admin/me
  - GET  /api/admin/orders
  - GET  /api/admin/orders/:id
  - PATCH /api/admin/orders/:id/status
  - GET  /api/admin/stats
  - GET  /api/admin/pricing
  - GET  /api/bundles (public)
  - GET  /api/bundles/:slug (public)
  - GET  /api/bundles/admin/list
  - POST /api/bundles/admin/create
  - PUT  /api/bundles/admin/:id
  - DELETE /api/bundles/admin/:id
  `);
});

export default app;

