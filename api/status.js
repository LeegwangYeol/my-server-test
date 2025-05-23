// 서버 상태 API 엔드포인트
export default function handler(req, res) {
  // 시스템 정보 수집
  const status = {
    status: "online",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || "development",
    memory: process.memoryUsage(),
    version: process.version,
  };

  res.status(200).json(status);
}
