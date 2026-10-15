/**
 * Safe arithmetic evaluator: recursive-descent parser over a token stream.
 * No eval / Function constructor, so an LLM (or a user) cannot smuggle code.
 */
const CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

const FUNCTIONS = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: (x, d = 0) => {
    const f = 10 ** d;
    return Math.round(x * f) / f;
  },
  floor: Math.floor,
  ceil: Math.ceil,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  sign: Math.sign,
  cbrt: Math.cbrt,
};

function tokenize(input) {
  // Normalise common spellings. Only commas *between digits* are treated as
  // thousands separators so `round(x, 2)` keeps its argument separator.
  const src = String(input)
    .replace(/(?<=\d),(?=\d{3}(?!\d))/g, '')
    .replace(/×/g, '*')
    .replace(/÷/g, '/');
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < src.length && /[0-9._]/.test(src[i])) num += src[i++];
      if (i < src.length && /[eE]/.test(src[i]) && /[0-9+-]/.test(src[i + 1] || '')) {
        num += src[i++];
        if (/[+-]/.test(src[i])) num += src[i++];
        while (i < src.length && /[0-9]/.test(src[i])) num += src[i++];
      }
      const value = Number(num.replace(/_/g, ''));
      if (!Number.isFinite(value)) throw new Error(`Bad number: ${num}`);
      tokens.push({ type: 'num', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let name = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) name += src[i++];
      tokens.push({ type: 'name', value: name.toLowerCase() });
      continue;
    }
    if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character "${ch}"`);
  }
  return tokens;
}

export function evaluateExpression(expression) {
  const tokens = tokenize(expression);
  let pos = 0;

  const peek = () => tokens[pos];
  const eat = (value) => {
    const tok = tokens[pos];
    if (tok && tok.type === 'op' && tok.value === value) {
      pos += 1;
      return true;
    }
    return false;
  };

  function parseExpression() {
    let left = parseTerm();
    for (;;) {
      const tok = peek();
      if (tok && tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
        pos += 1;
        const right = parseTerm();
        left = tok.value === '+' ? left + right : left - right;
      } else return left;
    }
  }

  function parseTerm() {
    let left = parseUnary();
    for (;;) {
      const tok = peek();
      if (tok && tok.type === 'op' && (tok.value === '*' || tok.value === '/' || tok.value === '%')) {
        pos += 1;
        const right = parseUnary();
        if (tok.value === '*') left *= right;
        else if (tok.value === '/') left /= right;
        else left %= right;
      } else return left;
    }
  }

  function parseUnary() {
    const tok = peek();
    if (tok && tok.type === 'op' && (tok.value === '-' || tok.value === '+')) {
      pos += 1;
      const value = parseUnary();
      return tok.value === '-' ? -value : value;
    }
    return parsePower();
  }

  function parsePower() {
    const base = parseAtom();
    const tok = peek();
    if (tok && tok.type === 'op' && tok.value === '^') {
      pos += 1;
      return base ** parseUnary();
    }
    return base;
  }

  function parseAtom() {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of expression');
    if (tok.type === 'num') {
      pos += 1;
      return tok.value;
    }
    if (tok.type === 'name') {
      pos += 1;
      if (tok.value in CONSTANTS) return CONSTANTS[tok.value];
      const fn = FUNCTIONS[tok.value];
      if (!fn) throw new Error(`Unknown name "${tok.value}"`);
      if (!eat('(')) throw new Error(`Expected "(" after ${tok.value}`);
      const args = [];
      if (!eat(')')) {
        args.push(parseExpression());
        while (eat(',')) args.push(parseExpression());
        if (!eat(')')) throw new Error('Missing closing ")"');
      }
      return fn(...args);
    }
    if (tok.type === 'op' && tok.value === '(') {
      pos += 1;
      const value = parseExpression();
      if (!eat(')')) throw new Error('Missing closing ")"');
      return value;
    }
    throw new Error(`Unexpected token "${tok.value}"`);
  }

  const result = parseExpression();
  if (pos !== tokens.length) throw new Error('Trailing input in expression');
  if (!Number.isFinite(result)) throw new Error('Result is not a finite number');
  return result;
}

export function prettyNumber(value) {
  if (Number.isInteger(value)) return String(value);
  const rounded = Number(value.toFixed(10));
  return String(rounded);
}
