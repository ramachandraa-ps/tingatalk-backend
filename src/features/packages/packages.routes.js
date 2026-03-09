import { Router } from 'express';
import { COIN_PACKAGES } from '../../shared/constants.js';

const router = Router();

router.get('/', (req, res) => {
  const activePackages = Object.values(COIN_PACKAGES).filter(p => p.isActive);
  res.json({ packages: activePackages });
});

export default router;
