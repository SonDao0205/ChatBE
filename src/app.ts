import cors from "cors";
import express from "express";

const app = express();

// Cho phép frontend gọi API từ domain khác.
app.use(cors());

// Đọc request body dạng JSON.
app.use(
  express.json({
    limit: "1mb",
  }),
);

export default app;
