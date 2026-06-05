import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import multer, { FileFilterCallback } from 'multer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/index.js';
import config from '../config/index.js';
import { authenticateAdmin, AuthRequest } from '../middleware/auth.js';
import { syncScryfall, getSyncStatus } from '../services/scryfallSync.js';

// Extend AuthRequest to include multer file
interface AuthRequestWithFile extends AuthRequest {
  file?: Express.Multer.File;
}

// Configure multer for memory storage (we'll process with sharp)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, WebP, and GIF are allowed.'));
    }
  },
});

const router = Router();

// POST /api/admin/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, name, is_active FROM admin_users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const admin = result.rows[0];

    if (!admin.is_active) {
      return res.status(401).json({ error: 'Account is disabled' });
    }

    const validPassword = await bcrypt.compare(password, admin.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await pool.query(
      'UPDATE admin_users SET last_login_at = NOW() WHERE id = $1',
      [admin.id]
    );

    // Generate JWT
    const token = jwt.sign(
      { adminId: admin.id, email: admin.email },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    res.json({
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/admin/me - Get current admin info
router.get('/me', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, created_at FROM admin_users WHERE id = $1',
      [req.adminId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    res.json({ admin: result.rows[0] });
  } catch (error) {
    console.error('Error fetching admin:', error);
    res.status(500).json({ error: 'Failed to fetch admin info' });
  }
});

// GET /api/admin/orders - Get all orders with filtering
router.get('/orders', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const {
      page = '1',
      limit = '20',
      status,
      search,
      sortBy = 'created_at',
      sortOrder = 'desc',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const offset = (pageNum - 1) * limitNum;

    let whereConditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (status) {
      whereConditions.push(`status = $${paramIndex++}`);
      params.push(status);
    }

    if (search) {
      whereConditions.push(`(
        tracking_code ILIKE $${paramIndex++} OR
        customer_email ILIKE $${paramIndex} OR
        customer_name ILIKE $${paramIndex}
      )`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Validate sort
    const validSortFields = ['created_at', 'total', 'status', 'tracking_code'];
    const sortField = validSortFields.includes(sortBy as string) ? sortBy : 'created_at';
    const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM orders ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get orders
    const ordersResult = await pool.query(`
      SELECT 
        id, tracking_code, customer_email, customer_name, shipping_address,
        status, subtotal, discount, total, stripe_session_id, stripe_payment_intent_id,
        is_paid, paid_at, notes, status_history, created_at, updated_at
      FROM orders
      ${whereClause}
      ORDER BY ${sortField} ${sortDir}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `, [...params, limitNum, offset]);

    // Get item counts for each order
    const orderIds = ordersResult.rows.map(o => o.id);
    let itemCounts: Record<string, number> = {};
    
    if (orderIds.length > 0) {
      const itemCountsResult = await pool.query(`
        SELECT order_id, SUM(quantity) as item_count
        FROM order_items
        WHERE order_id = ANY($1)
        GROUP BY order_id
      `, [orderIds]);
      
      itemCounts = itemCountsResult.rows.reduce((acc, row) => {
        acc[row.order_id] = parseInt(row.item_count, 10);
        return acc;
      }, {} as Record<string, number>);
    }

    const orders = ordersResult.rows.map(order => ({
      ...order,
      itemCount: itemCounts[order.id] || 0,
    }));

    res.json({
      orders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// GET /api/admin/orders/:id - Get single order with items
router.get('/orders/:id', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const itemsResult = await pool.query(`
      SELECT * FROM order_items WHERE order_id = $1
    `, [id]);

    res.json({
      order: {
        ...orderResult.rows[0],
        items: itemsResult.rows,
      },
    });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// PATCH /api/admin/orders/:id/status - Update order status
router.patch('/orders/:id/status', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body;

    const validStatuses = ['pending', 'processing', 'printing', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Get current order
    const orderResult = await pool.query('SELECT status_history FROM orders WHERE id = $1', [id]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Update status history
    const statusHistory = orderResult.rows[0].status_history || [];
    statusHistory.push({
      status,
      timestamp: new Date().toISOString(),
      note: note || `Status updated to ${status}`,
    });

    // Update order
    await pool.query(`
      UPDATE orders
      SET status = $1, status_history = $2, updated_at = NOW()
      WHERE id = $3
    `, [status, JSON.stringify(statusHistory), id]);

    res.json({ success: true, status });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// PATCH /api/admin/orders/:id/notes - Update order notes
router.patch('/orders/:id/notes', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    await pool.query(
      'UPDATE orders SET notes = $1, updated_at = NOW() WHERE id = $2',
      [notes, id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating order notes:', error);
    res.status(500).json({ error: 'Failed to update order notes' });
  }
});

// GET /api/admin/stats - Dashboard stats
router.get('/stats', authenticateAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM orders) as total_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'pending') as pending_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'processing') as processing_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'printing') as printing_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'shipped') as shipped_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'delivered') as delivered_orders,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE is_paid = true) as total_revenue,
        (SELECT COUNT(*) FROM cards WHERE is_active = true) as total_cards
    `);

    res.json({ stats: stats.rows[0] });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/admin/pricing - Get pricing config
router.get('/pricing', authenticateAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM pricing_config ORDER BY name');
    res.json({ pricing: result.rows });
  } catch (error) {
    console.error('Error fetching pricing:', error);
    res.status(500).json({ error: 'Failed to fetch pricing' });
  }
});

// PUT /api/admin/pricing/:name - Update pricing config
router.put('/pricing/:name', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name } = req.params;
    const { value, description } = req.body;

    const result = await pool.query(`
      UPDATE pricing_config
      SET value = $1, description = COALESCE($2, description), updated_at = NOW()
      WHERE name = $3
      RETURNING *
    `, [value, description, name]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pricing config not found' });
    }

    res.json({ pricing: result.rows[0] });
  } catch (error) {
    console.error('Error updating pricing:', error);
    res.status(500).json({ error: 'Failed to update pricing' });
  }
});

// POST /api/admin/sync-cards - Trigger Scryfall sync
router.post('/sync-cards', authenticateAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const status = getSyncStatus();
    
    // If already syncing, return current status
    if (status.status === 'downloading' || status.status === 'processing') {
      return res.json({ 
        message: 'Sync already in progress',
        sync: status 
      });
    }
    
    // Start sync in background (don't await)
    syncScryfall(true).catch(err => {
      console.error('Background sync failed:', err);
    });
    
    res.json({ 
      message: 'Sync started',
      sync: getSyncStatus()
    });
  } catch (error) {
    console.error('Error starting sync:', error);
    res.status(500).json({ error: 'Failed to start sync' });
  }
});

// GET /api/admin/sync-status - Get current sync status
router.get('/sync-status', authenticateAdmin, async (_req: AuthRequest, res: Response) => {
  res.json({ sync: getSyncStatus() });
});

// POST /api/admin/upload - Upload an image
router.post('/upload', authenticateAdmin, upload.single('image'), async (req: AuthRequestWithFile, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(config.dataDir, 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });

    // Generate unique filename
    const fileId = uuidv4();
    const filename = `${fileId}.jpg`;
    const filepath = path.join(uploadsDir, filename);

    // Process and save image with sharp
    await sharp(req.file.buffer)
      .resize(1200, 1200, { 
        fit: 'inside', 
        withoutEnlargement: true 
      })
      .jpeg({ quality: 85 })
      .toFile(filepath);

    // Return the URL path (relative to /images)
    const imageUrl = `/images/uploads/${filename}`;
    
    res.json({ 
      success: true,
      url: imageUrl,
      filename 
    });
  } catch (error: any) {
    console.error('Error uploading image:', error);
    res.status(500).json({ error: error.message || 'Failed to upload image' });
  }
});

// DELETE /api/admin/upload/:filename - Delete an uploaded image
router.delete('/upload/:filename', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { filename } = req.params;
    
    // Validate filename (prevent directory traversal)
    if (!filename || filename.includes('/') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const filepath = path.join(config.dataDir, 'uploads', filename);
    
    try {
      await fs.unlink(filepath);
      res.json({ success: true });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.json({ success: true }); // Already deleted
      } else {
        throw err;
      }
    }
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// GET /api/admin/settings - Get all site settings
router.get('/settings', authenticateAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query('SELECT name, value, description, updated_at FROM site_settings');
    const settings = result.rows.reduce((acc, row) => {
      acc[row.name] = {
        value: row.value,
        description: row.description,
        updated_at: row.updated_at,
      };
      return acc;
    }, {} as Record<string, { value: string; description: string; updated_at: string }>);
    res.json({ settings });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /api/admin/settings/:name - Update a site setting
router.put('/settings/:name', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }

    const result = await pool.query(`
      UPDATE site_settings
      SET value = $1, updated_at = NOW()
      WHERE name = $2
      RETURNING *
    `, [value, name]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Setting not found' });
    }

    res.json({ setting: result.rows[0] });
  } catch (error) {
    console.error('Error updating setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

export default router;

