export const formatSupabaseDate = (date: Date): string => {
  const pad = (n: number) => (n < 10 ? "0" + n : n);
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  const milliseconds = date.getUTCMilliseconds().toString().padStart(6, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}+00`;
};
