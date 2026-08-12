import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDaticertXml, selectImapUids, senderTrusted } from '../src/email-pec.js';

test('la whitelist mittenti usa corrispondenze esatte o dominio, non sottostringhe', () => {
  const patterns = [{ type: 'EMAIL', value: 'ufficio@example.it' }, { type: 'DOMAIN', value: 'pec.ader.it' }];
  assert.equal(senderTrusted('ufficio@example.it', patterns), true);
  assert.equal(senderTrusted('truffaufficio@example.it.evil.test', patterns), false);
  assert.equal(senderTrusted('notifiche@pec.ader.it', patterns), true);
  assert.equal(senderTrusted('notifiche@fakepec.ader.it', patterns), false);
});

test('un reset UIDVALIDITY ricomincia da UID 1 senza ereditare il vecchio cursore', () => {
  const result = selectImapUids([1, 2, 3, 4, 5], { uidValidity: '10', lastUid: 999 }, { uidValidity: '11', maxMessages: 2, overlapUids: 1 });
  assert.deepEqual(result.selected, [1, 2]);
  assert.equal(result.lastUid, 0);
  assert.equal(result.reset, true);
  assert.equal(result.morePending, true);
});

test('il backfill procede dal più vecchio e non salta messaggi', () => {
  const first = selectImapUids([1, 2, 3, 4, 5], {}, { uidValidity: '1', maxMessages: 2, overlapUids: 1 });
  assert.deepEqual(first.selected, [1, 2]);
  const second = selectImapUids([1, 2, 3, 4, 5], { uidValidity: '1', lastUid: 2 }, { uidValidity: '1', maxMessages: 2, overlapUids: 1 });
  assert.deepEqual(second.selected, [2, 3, 4]);
});

test('estrae mittente e identificativo dal daticert XML', () => {
  const parsed = parseDaticertXml('<postacert><mittente>notifiche@pec.example.it</mittente><oggetto>Atto</oggetto><identificativo>ABC123</identificativo></postacert>');
  assert.equal(parsed.mittente, 'notifiche@pec.example.it');
  assert.equal(parsed.oggetto, 'Atto');
  assert.equal(parsed.identificativo, 'ABC123');
});
