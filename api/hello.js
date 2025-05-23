// 간단한 인사 API 엔드포인트
export default function handler(req, res) {
  const name = req.query.name || "방문자";

  res.status(200).json({
    message: `안녕하세요, ${name}님! 환영합니다.`,
    timestamp: new Date().toISOString(),
  });
}
