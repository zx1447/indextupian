import { Request, Response } from 'express';

export default async (req: Request, res: Response) => {
  const path = req.path || '/';
  
  if (path === '/api/status' || path === '/status') {
    return res.json({
      status: 'online',
      service: 'nezha-keepalive',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      platform: 'nhost-brazil'
    });
  }
  
  if (path === '/ping') {
    return res.json({ pong: true, time: Date.now() });
  }
  
  return res.json({
    service: 'Nezha Agent - Nhost Brazil',
    status: 'running',
    endpoints: ['/api/status', '/ping'],
    note: 'Nhost Free: functions only (10s timeout, no persistent containers)'
  });
};
