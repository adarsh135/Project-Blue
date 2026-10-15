import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpression, prettyNumber } from '../server/agent/math.js';

test('calculator: arithmetic and precedence', () => {
  assert.equal(evaluateExpression('2 + 3 * 4'), 14);
  assert.equal(evaluateExpression('(2 + 3) * 4'), 20);
  assert.equal(evaluateExpression('(1250 * 1.18) / 3'), 491.6666666666667);
  assert.equal(evaluateExpression('2 ^ 10'), 1024);
  assert.equal(evaluateExpression('10 % 3'), 1);
  assert.equal(evaluateExpression('-5 + 2'), -3);
  assert.equal(evaluateExpression('1_000 + 1'), 1001);
});

test('calculator: functions and constants', () => {
  assert.equal(evaluateExpression('sqrt(144)'), 12);
  assert.equal(evaluateExpression('round(sqrt(2), 3)'), 1.414);
  assert.equal(evaluateExpression('max(1, 5, 3)'), 5);
  assert.ok(Math.abs(evaluateExpression('sin(0)')) < 1e-12);
  assert.ok(Math.abs(evaluateExpression('pi * 2') - Math.PI * 2) < 1e-12);
  assert.equal(evaluateExpression('log(1000)'), 3);
});

test('calculator: allows x and ÷ symbols', () => {
  assert.equal(evaluateExpression('6 × 7'), 42);
  assert.equal(evaluateExpression('84 ÷ 2'), 42);
});

test('calculator: rejects code execution attempts', () => {
  assert.throws(() => evaluateExpression('process.exit(1)'));
  assert.throws(() => evaluateExpression('require("fs")'));
  assert.throws(() => evaluateExpression('(function(){})()'));
  assert.throws(() => evaluateExpression('1 +'));
  assert.throws(() => evaluateExpression('1/0'));
});

test('prettyNumber trims float noise', () => {
  assert.equal(prettyNumber(4), '4');
  assert.equal(prettyNumber(0.1 + 0.2), '0.3');
});
