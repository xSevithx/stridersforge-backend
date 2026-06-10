import { Router, Request, Response } from 'express';
import { pool } from '../db/index.js';
import { authenticateAdmin, AuthRequest } from '../middleware/auth.js';

const router = Router();

// POST /api/leads - Public: Submit a contact form
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    if (message.length > 5000) {
      return res.status(400).json({ error: 'Message is too long (max 5000 characters)' });
    }

    const result = await pool.query(
      `INSERT INTO leads (name, email, subject, message)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [name.trim(), email.trim().toLowerCase(), subject?.trim() || null, message.trim()]
    );

    res.status(201).json({
      success: true,
      lead: { id: result.rows[0].id, created_at: result.rows[0].created_at },
    });
  } catch (error) {
    console.error('Error submitting lead:', error);
    res.status(500).json({ error: 'Failed to submit contact form' });
  }
});

// GET /api/leads/admin - Admin: Get all leads with filtering
router.get('/admin', authenticateAdmin, async (req: AuthRequest, res: Response) => {
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
        name ILIKE $${paramIndex} OR
        email ILIKE $${paramIndex} OR
        subject ILIKE $${paramIndex} OR
        message ILIKE $${paramIndex}
      )`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    const validSortFields = ['created_at', 'name', 'email', 'status'];
    const sortField = validSortFields.includes(sortBy as string) ? sortBy : 'created_at';
    const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM leads ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const leadsResult = await pool.query(`
      SELECT id, name, email, subject, message, status, admin_notes, created_at, updated_at
      FROM leads
      ${whereClause}
      ORDER BY ${sortField} ${sortDir}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `, [...params, limitNum, offset]);

    res.json({
      leads: leadsResult.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// PATCH /api/leads/admin/:id/status - Admin: Update lead status
router.patch('/admin/:id/status', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['new', 'contacted', 'closed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await pool.query(
      `UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json({ lead: result.rows[0] });
  } catch (error) {
    console.error('Error updating lead status:', error);
    res.status(500).json({ error: 'Failed to update lead status' });
  }
});

// PATCH /api/leads/admin/:id/notes - Admin: Update admin notes
router.patch('/admin/:id/notes', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const result = await pool.query(
      `UPDATE leads SET admin_notes = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [notes, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json({ lead: result.rows[0] });
  } catch (error) {
    console.error('Error updating lead notes:', error);
    res.status(500).json({ error: 'Failed to update lead notes' });
  }
});

// DELETE /api/leads/admin/:id - Admin: Delete a lead
router.delete('/admin/:id', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query('DELETE FROM leads WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting lead:', error);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

export default router;
