import test from 'node:test';
import assert from 'node:assert/strict';
import { metricParts } from '../../src/intelligence-ui/surface-presentation.mjs';

test('metric typography preserves original precision, sign and unit', () => {
  for (const value of ['174.50 元', '0', '-0.35%', '1,234.000 USD', '¥100.00', '12 件', '4 份']) {
    const parts = metricParts(value);
    assert.ok(parts);
    assert.equal(parts.number + parts.unit, value);
  }
});

test('narrative, identifiers and unknown units are never converted into a metric', () => {
  for (const value of ['待核对金额：174.50 元', 'TEST-001', '12/25', '174.50 or 200.00', '1.23e4', '1,23', '', null, true, { amount: 100 }]) {
    assert.equal(metricParts(value), null, String(value));
  }
});
