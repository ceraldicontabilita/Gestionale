export function roundMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Importo non valido');
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

export function parseMoney(value, { allowNegative = false, label = 'Importo' } = {}) {
  if (value === null || value === undefined || value === '') return null;

  let parsed;
  if (typeof value === 'number') {
    parsed = value;
  } else {
    let raw = String(value)
      .replace(/\u00a0/g, ' ')
      .replace(/[€$£]/g, '')
      .replace(/\s+/g, '')
      .trim();

    if (!raw || !/^[+-]?[\d.,]+$/.test(raw)) {
      throw new Error(`${label} non valido: ${value}`);
    }

    let sign = '';
    if (raw[0] === '+' || raw[0] === '-') {
      sign = raw[0];
      raw = raw.slice(1);
    }
    if (!raw || !/\d/.test(raw)) throw new Error(`${label} non valido: ${value}`);

    const commaCount = (raw.match(/,/g) || []).length;
    const dotCount = (raw.match(/\./g) || []).length;
    let normalized = raw;

    if (commaCount && dotCount) {
      const decimalSeparator = raw.lastIndexOf(',') > raw.lastIndexOf('.') ? ',' : '.';
      const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
      normalized = raw.split(groupingSeparator).join('');
      const decimalIndex = normalized.lastIndexOf(decimalSeparator);
      normalized = `${normalized.slice(0, decimalIndex).split(decimalSeparator).join('')}.${normalized.slice(decimalIndex + 1)}`;
    } else if (commaCount) {
      const parts = raw.split(',');
      const fraction = parts.at(-1);
      normalized = fraction.length <= 2
        ? `${parts.slice(0, -1).join('') || '0'}.${fraction}`
        : parts.join('');
    } else if (dotCount) {
      const parts = raw.split('.');
      const fraction = parts.at(-1);
      if (dotCount === 1 && fraction.length === 3 && parts[0].length <= 3) {
        normalized = parts.join('');
      } else if (fraction.length <= 2) {
        normalized = `${parts.slice(0, -1).join('') || '0'}.${fraction}`;
      } else {
        normalized = parts.join('');
      }
    }

    parsed = Number(`${sign}${normalized}`);
  }

  if (!Number.isFinite(parsed)) throw new Error(`${label} non valido: ${value}`);
  const rounded = roundMoney(parsed);
  if (!allowNegative && rounded < 0) throw new Error(`${label} non può essere negativo`);
  return rounded;
}
