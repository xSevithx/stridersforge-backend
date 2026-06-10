import { Router, Request, Response } from 'express';
import { pool } from '../db/index.js';
import { authenticateAdmin, AuthRequest } from '../middleware/auth.js';

const router = Router();

// GET /api/faqs - Public: Get all active FAQs (sorted)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT id, question, answer, sort_order FROM faqs WHERE is_active = true ORDER BY sort_order ASC, created_at ASC'
    );
    res.json({ faqs: result.rows });
  } catch (error) {
    console.error('Error fetching FAQs:', error);
    res.status(500).json({ error: 'Failed to fetch FAQs' });
  }
});

// GET /api/faqs/admin - Admin: Get all FAQs (including inactive)
router.get('/admin', authenticateAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM faqs ORDER BY sort_order ASC, created_at ASC'
    );
    res.json({ faqs: result.rows });
  } catch (error) {
    console.error('Error fetching FAQs:', error);
    res.status(500).json({ error: 'Failed to fetch FAQs' });
  }
});

// POST /api/faqs/admin - Admin: Create a new FAQ
router.post('/admin', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { question, answer, sortOrder } = req.body;

    if (!question || !answer) {
      return res.status(400).json({ error: 'Question and answer are required' });
    }

    const result = await pool.query(
      `INSERT INTO faqs (question, answer, sort_order)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [question.trim(), answer.trim(), sortOrder ?? 0]
    );

    res.status(201).json({ faq: result.rows[0] });
  } catch (error) {
    console.error('Error creating FAQ:', error);
    res.status(500).json({ error: 'Failed to create FAQ' });
  }
});

// PUT /api/faqs/admin/:id - Admin: Update a FAQ
router.put('/admin/:id', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { question, answer, sortOrder, isActive } = req.body;

    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (question !== undefined) {
      fields.push(`question = $${paramIndex++}`);
      values.push(question.trim());
    }
    if (answer !== undefined) {
      fields.push(`answer = $${paramIndex++}`);
      values.push(answer.trim());
    }
    if (sortOrder !== undefined) {
      fields.push(`sort_order = $${paramIndex++}`);
      values.push(sortOrder);
    }
    if (isActive !== undefined) {
      fields.push(`is_active = $${paramIndex++}`);
      values.push(isActive);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    fields.push('updated_at = NOW()');
    values.push(id);

    const result = await pool.query(
      `UPDATE faqs SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'FAQ not found' });
    }

    res.json({ faq: result.rows[0] });
  } catch (error) {
    console.error('Error updating FAQ:', error);
    res.status(500).json({ error: 'Failed to update FAQ' });
  }
});

// DELETE /api/faqs/admin/:id - Admin: Delete a FAQ
router.delete('/admin/:id', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query('DELETE FROM faqs WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'FAQ not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting FAQ:', error);
    res.status(500).json({ error: 'Failed to delete FAQ' });
  }
});

// PUT /api/faqs/admin/reorder - Admin: Bulk update sort order
router.put('/admin/reorder', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { items } = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of items) {
        await client.query(
          'UPDATE faqs SET sort_order = $1, updated_at = NOW() WHERE id = $2',
          [item.sortOrder, item.id]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error reordering FAQs:', error);
    res.status(500).json({ error: 'Failed to reorder FAQs' });
  }
});

export default router;
