/**
 * Чтение ZIP без зависимостей: только то, что нужно для отчётов площадок.
 *
 * Зачем свой разбор, а не библиотека: архивы приходят маленькие (килобайты),
 * формат стабильный (store или deflate), а лишняя зависимость в проде — лишний
 * риск. inflateRawSync есть в node:zlib.
 *
 * ГЛАВНОЕ, из-за чего модуль появился. Ozon на пачку из N кампаний отдаёт ZIP
 * с N файлами — по одному на кампанию. Прежний unzipSingle читал ТОЛЬКО ПЕРВУЮ
 * запись central directory: из десяти кампаний в пачке данные доставались по
 * одной, и обычно это была кампания без расхода. Кабинет видел 3,3% реальной
 * рекламы Ozon (аудит 04.09: 22 593 ₽ из 674 539 ₽). Здесь читаются ВСЕ записи.
 */
import { inflateRawSync } from 'node:zlib';

export type ZipEntry = { name: string; data: Buffer };

/** Все файлы архива по порядку central directory. */
export function unzipAll(buf: Buffer): ZipEntry[] {
  // EOCD: PK\x05\x06, ищем с конца (комментарий обычно пуст).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);

  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error(`zip: bad central dir at entry ${n}`);
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const localOffset = buf.readUInt32LE(cd + 42);
    const name = buf.subarray(cd + 46, cd + 46 + nameLen).toString('utf-8');

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip: unsupported method ${method} in ${name}`);
    out.push({ name, data });

    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Первый файл архива — для форматов, где файл ровно один. */
export function unzipSingle(buf: Buffer): Buffer {
  const all = unzipAll(buf);
  if (!all.length) throw new Error('zip: empty archive');
  return all[0].data;
}

/** Признак ZIP по сигнатуре локального заголовка PK\x03\x04. */
export function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
}
