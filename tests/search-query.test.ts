import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeConversationSearchQuery } from '../src/search-query'

test('normalizes NBSP in the nickname that failed cloud search', () => {
  assert.equal(normalizeConversationSearchQuery('ᖰ•\u00a0֊\u00a0•ᖳ'), 'ᖰ• ֊ •ᖳ')
})

test('collapses repeated spaces, tabs and newlines to ordinary spaces', () => {
  assert.equal(normalizeConversationSearchQuery('  等待\t\t天使\n的   妹妹  '), '等待 天使 的 妹妹')
})

test('trims leading and trailing Unicode whitespace', () => {
  assert.equal(normalizeConversationSearchQuery('\u00a0\u2003TwT\u3000'), 'TwT')
})

test('preserves an ordinary Chinese nickname', () => {
  assert.equal(normalizeConversationSearchQuery('我坏点怎么了'), '我坏点怎么了')
})

test('preserves mathematical script characters instead of applying NFKC', () => {
  assert.equal(normalizeConversationSearchQuery('  𝓮𝓽𝓪\u00a0'), '𝓮𝓽𝓪')
})

test('preserves punctuation and non-whitespace invisible characters', () => {
  assert.equal(normalizeConversationSearchQuery('唉_苦味片（6\u200b'), '唉_苦味片（6\u200b')
})
