export const createRandomId = (prefix: string) => {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const value = Array.from(bytes, byte => byte.toString(36).padStart(2, "0")).join("");

  return `${prefix}_${value}`;
};

export const createRoomCode = () => {
  const value = Math.floor(100_000 + Math.random() * 900_000);

  return String(value);
};
