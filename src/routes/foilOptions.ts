import { Router, Request, Response } from 'express';
import { pool } from '../db/index.js';
import { authenticateAdmin, AuthRequest } from '../middleware/auth.js';

const router = Router();

// GET /api/foil-options - Public: list active foil options
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT id, name, slug, upcharge FROM foil_options WHERE is_active = true ORDER BY sort_order, name'
    );
    res.json({ foilOptions: result.rows });
  } catch (error) {
    console.error('Error fetching foil options:', error);
    res.status(500).json({ error: 'Failed to fetch foil options' });
  }
});

// GET /api/foil-options/admin/list - Admin: list all foil options
router.get('/admin/list', authenticateAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM foil_options ORDER BY sort_order, name'
    );
    res.json({ foilOptions: result.rows });
  } catch (error) {
    console.error('Error fetching foil options:', error);
    res.status(500).json({ error: 'Failed to fetch foil options' });
  }
});

// POST /api/foil-options/admin/create - Admin: create foil option
router.post('/admin/create', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name, upcharge, sortOrder } = req.body;

    if (!name || upcharge === undefined) {
      return res.status(400).json({ error: 'Name and upcharge are required' });
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const result = await pool.query(`
      INSERT INTO foil_options (name, slug, upcharge, sort_order)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [name, slug, parseFloat(upcharge), sortOrder || 0]);

    res.json({ foilOption: result.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A foil option with that name already exists' });
    }
    console.error('Error creating foil option:', error);
    res.status(500).json({ error: 'Failed to create foil option' });
  }
});

// PUT /api/foil-options/admin/:id - Admin: update foil option
router.put('/admin/:id', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, upcharge, isActive, sortOrder } = req.body;

    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 0;

    if (name !== undefined) {
      paramCount++;
      updates.push(`name = $${paramCount}`);
      values.push(name);
      paramCount++;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      updates.push(`slug = $${paramCount}`);
      values.push(slug);
    }
    if (upcharge !== undefined) {
      paramCount++;
      updates.push(`upcharge = $${paramCount}`);
      values.push(parseFloat(upcharge));
    }
    if (isActive !== undefined) {
      paramCount++;
      updates.push(`is_active = $${paramCount}`);
      values.push(isActive);
    }
    if (sortOrder !== undefined) {
      paramCount++;
      updates.push(`sort_order = $${paramCount}`);
      values.push(sortOrder);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = NOW()');
    paramCount++;
    values.push(id);

    const result = await pool.query(
      `UPDATE foil_options SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Foil option not found' });
    }

    res.json({ foilOption: result.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A foil option with that name already exists' });
    }
    console.error('Error updating foil option:', error);
    res.status(500).json({ error: 'Failed to update foil option' });
  }
});

// DELETE /api/foil-options/admin/:id - Admin: delete foil option
router.delete('/admin/:id', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM foil_options WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Foil option not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting foil option:', error);
    res.status(500).json({ error: 'Failed to delete foil option' });
  }
});

export default router;
