// 간단한 서버리스 API 엔드포인트
export default function handler(req, res) {
  res.status(200).json({
    message: "안녕하세요! 서버리스 API가 정상적으로 작동 중입니다.",
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
  });
}
