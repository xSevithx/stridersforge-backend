import { Router, Request, Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { pool } from '../db/index.js';
import { authenticateAdmin } from '../middleware/auth.js';
import config from '../config/index.js';

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const PRODUCTS_IMAGE_DIR = path.join(config.dataDir, 'product-images');

const ensureProductImagesDir = async () => {
  await fs.mkdir(PRODUCTS_IMAGE_DIR, { recursive: true });
};

// GET /api/products - Public listing of active products
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT id, name, description, image_path, price, stock_quantity, sort_order
      FROM custom_products
      WHERE is_active = true
      ORDER BY sort_order ASC, name ASC
    `);
    res.json({ products: result.rows });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /api/products/:id - Single product
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM custom_products WHERE id = $1 AND is_active = true',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ product: result.rows[0] });
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// --- Admin Routes (JWT protected) ---

// GET /api/products/admin/list - All products including inactive
router.get('/admin/list', authenticateAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT * FROM custom_products ORDER BY sort_order ASC, name ASC
    `);
    res.json({ products: result.rows });
  } catch (error) {
    console.error('Error fetching products (admin):', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// POST /api/products/admin/create - Create product with optional image
router.post('/admin/create', authenticateAdmin, upload.single('image'), async (req: Request, res: Response) => {
  try {
    const { name, description, price, stock_quantity, sort_order } = req.body;

    if (!name || !price) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    let imagePath: string | null = null;

    if (req.file) {
      await ensureProductImagesDir();
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
      const filePath = path.join(PRODUCTS_IMAGE_DIR, filename);

      await sharp(req.file.buffer)
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(filePath);

      imagePath = `product-images/${filename}`;
    }

    const result = await pool.query(`
      INSERT INTO custom_products (name, description, image_path, price, stock_quantity, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      name,
      description || null,
      imagePath,
      parseFloat(price).toFixed(2),
      stock_quantity != null && stock_quantity !== '' ? parseInt(stock_quantity) : null,
      parseInt(sort_order) || 0,
    ]);

    res.json({ product: result.rows[0] });
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// PUT /api/products/admin/:id - Update product
router.put('/admin/:id', authenticateAdmin, upload.single('image'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, price, stock_quantity, is_active, sort_order } = req.body;

    const existing = await pool.query('SELECT * FROM custom_products WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    let imagePath = existing.rows[0].image_path;

    if (req.file) {
      await ensureProductImagesDir();
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
      const filePath = path.join(PRODUCTS_IMAGE_DIR, filename);

      await sharp(req.file.buffer)
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(filePath);

      // Delete old image if it exists
      if (existing.rows[0].image_path) {
        const oldPath = path.join(config.dataDir, existing.rows[0].image_path);
        await fs.unlink(oldPath).catch(() => {});
      }

      imagePath = `product-images/${filename}`;
    }

    const result = await pool.query(`
      UPDATE custom_products
      SET name = $1, description = $2, image_path = $3, price = $4,
          stock_quantity = $5, is_active = $6, sort_order = $7, updated_at = NOW()
      WHERE id = $8
      RETURNING *
    `, [
      name || existing.rows[0].name,
      description !== undefined ? description : existing.rows[0].description,
      imagePath,
      price ? parseFloat(price).toFixed(2) : existing.rows[0].price,
      stock_quantity != null && stock_quantity !== '' ? parseInt(stock_quantity) : null,
      is_active !== undefined ? is_active === 'true' || is_active === true : existing.rows[0].is_active,
      sort_order !== undefined ? parseInt(sort_order) || 0 : existing.rows[0].sort_order,
      id,
    ]);

    res.json({ product: result.rows[0] });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// DELETE /api/products/admin/:id - Soft delete (set inactive)
router.delete('/admin/:id', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await pool.query(
      'UPDATE custom_products SET is_active = false, updated_at = NOW() WHERE id = $1',
      [id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

export default router;
