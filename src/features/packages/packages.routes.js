import { Router } from 'express';
import { COIN_PACKAGES } from '../../shared/constants.js';

const router = Router();

/**
 * @openapi
 * /api/packages:
 *   get:
 *     tags:
 *       - Packages
 *     summary: List active coin packages
 *     description: Returns all active coin packages available for purchase.
 *     responses:
 *       200:
 *         description: List of active coin packages
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 packages:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       coinAmount:
 *                         type: integer
 *                       priceInRupees:
 *                         type: number
 *                       isActive:
 *                         type: boolean
 */
router.get('/', (req, res) => {
  const activePackages = Object.values(COIN_PACKAGES).filter(p => p.isActive);
  res.json({ packages: activePackages });
});

export default router;
