import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { AppDataSource } from './config/database';
import conversationRoutes from './routes/conversation.routes';
import webhookRoutes from './routes/webhook.routes';
import { setSocketServer } from './service/socket.service';

dotenv.config();

const PORT = parseInt(process.env.PORT || '8082', 10);
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const allowedClientOrigins = new Set(
  CLIENT_URL.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function isAllowedClientOrigin(origin?: string) {
  if (!origin) return true;
  if (allowedClientOrigins.has(origin)) return true;
  if (process.env.NODE_ENV === 'production') return false;

  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

function corsOrigin(
  origin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void,
) {
  callback(null, isAllowedClientOrigin(origin));
}

async function bootstrap() {
  // ─── Kết nối MySQL ─────────────────────────────────────────────
  try {
    await AppDataSource.initialize();
    console.log('✅ MySQL connected successfully');
  } catch (err) {
    console.error('❌ MySQL connection failed:', err);
    process.exit(1);
  }

  // ─── Khởi tạo Express ──────────────────────────────────────────
  const app = express();
  const httpServer = createServer(app);

  // ─── Middlewares ───────────────────────────────────────────────
  app.use(helmet());
  app.use(cors({
    origin: corsOrigin,
    credentials: true,
  }));
  app.use(
    '/api/v1/webhooks/marketplace-messages',
    express.raw({ type: 'application/json', limit: '1mb' }),
    webhookRoutes,
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(pinoHttp());

  // Rate limiting
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 phút
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  }));

  // ─── Health check ──────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'chat-backend',
      timestamp: new Date().toISOString(),
      db: AppDataSource.isInitialized ? 'connected' : 'disconnected',
    });
  });

  // ─── Routes ────────────────────────────────────────────────────
  // TODO: import và đăng ký routes tại đây
  // app.use('/api/v1/messages', messageRoutes);
  app.use('/api/v1', conversationRoutes);

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const message =
        error instanceof Error ? error.message : 'Internal server error.';
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        message,
        data: null,
      });
    },
  );

  // ─── Socket.IO ────────────────────────────────────────────────
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
  });
  setSocketServer(io);

  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    socket.on('join_conversation', (conversationId: string) => {
      socket.join(`conversation:${conversationId}`);
      console.log(`User ${socket.id} joined conversation: ${conversationId}`);
    });

    socket.on('leave_conversation', (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
      console.log(`User ${socket.id} left conversation: ${conversationId}`);
    });

    socket.on('join_room', (roomId: string) => {
      socket.join(roomId);
      console.log(`User ${socket.id} joined room: ${roomId}`);
    });

    socket.on('send_message', (data: { roomId: string; message: string }) => {
      io.to(data.roomId).emit('receive_message', {
        socketId: socket.id,
        message: data.message,
        timestamp: new Date().toISOString(),
      });
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
    });
  });

  // ─── Start server ──────────────────────────────────────────────
  httpServer.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // ─── Graceful shutdown ─────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n⚠️  Received ${signal}. Shutting down gracefully...`);
    await AppDataSource.destroy();
    console.log('✅ Database connection closed');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Fatal error during bootstrap:', err);
  process.exit(1);
});
