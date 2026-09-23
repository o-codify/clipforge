/**
 * Хранение паролей.
 *
 * scrypt из стандартной библиотеки: он специально сделан медленным и
 * требовательным к памяти, поэтому перебор по украденной базе стоит
 * дорого. Тянуть ради этого стороннюю зависимость незачем.
 *
 * Соль своя у каждого пароля - иначе одинаковые пароли дают одинаковые
 * хэши, и по базе сразу видно, кто чем пользуется. Параметры хранятся
 * внутри строки: когда железо станет быстрее и цену понадобится поднять,
 * старые хэши продолжат проверяться своими параметрами.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * promisify теряет перегрузку scrypt с параметрами, поэтому тип задан
 * явно. Без этого пришлось бы звать колбэчный вариант руками.
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Параметры для новых паролей. N=2^15 - около 100 мс на проверку. */
const COST = 32768;
const BLOCK_SIZE = 8;
const PARALLEL = 1;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N: COST, r: BLOCK_SIZE, p: PARALLEL,
    // По умолчанию node не даёт scrypt столько памяти, сколько просит N.
    maxmem: 256 * 1024 * 1024,
  });

  return [
    "scrypt", COST, BLOCK_SIZE, PARALLEL,
    salt.toString("base64"), key.toString("base64"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, cost, blockSize, parallel, salt, expected] = parts as [
    string, string, string, string, string, string,
  ];
  const expectedKey = Buffer.from(expected, "base64");

  let key: Buffer;
  try {
    key = await scryptAsync(
      password.normalize("NFKC"),
      Buffer.from(salt, "base64"),
      expectedKey.length,
      {
        N: Number(cost), r: Number(blockSize), p: Number(parallel),
        maxmem: 256 * 1024 * 1024,
      },
    );
  } catch {
    return false;
  }

  // Сравнение за постоянное время: обычное == выходит из цикла на первом
  // несовпадении, и по времени ответа хэш подбирается побайтово.
  return key.length === expectedKey.length && timingSafeEqual(key, expectedKey);
}

/** Пароль для первого администратора, если его не задали в окружении. */
export const generatePassword = (): string =>
  randomBytes(12).toString("base64url");
