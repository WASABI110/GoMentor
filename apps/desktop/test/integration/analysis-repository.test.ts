import { describe, expect, it } from 'vitest'
import type { SgfCollection } from '@gomentor/core/sgf/ast'
import { parseSgf } from '@gomentor/core/sgf/parser'
import { openDatabase } from '../../src/main/db/connection'
import {
  createAnalysisRepository,
  type AnalysisRow,
} from '../../src/main/db/repositories/analysis'
import { createGameStore } from '../../src/main/library/store'
import { createTestDb } from './test-db'

/**
 * The analysis repository against a real database file: rows, the resume
 * reads, and the ledger transitions the batch scheduler relies on.
 *
 * Real store inserts precede every row write on purpose: `analysis.game_id`
 * references `games(id)` with `ON DELETE CASCADE` and foreign keys are ON, so
 * the repository is exercised against the true constraint surface, not a
 * schema-less in-memory stand-in. The cascade itself (delete a game → its rows
 * and ledger entry go too) is asserted here because queue planning reads the
 * ledger and a dangling entry would resurrect a deleted game as work.
 */

const NOW = '2026-09-10T00:00:00.000Z'

function row(moveNumber: number, overrides: Partial<AnalysisRow> = {}): AnalysisRow {
  return {
    moveNumber,
    player: moveNumber % 2 === 0 ? 'black' : 'white',
    winrate: 0.5 + moveNumber / 100,
    scoreLead: 1.5,
    winrateLoss: 0.01,
    topCandidateCoord: 'D16',
    topCandidateWinrate: 0.55,
    ...overrides,
  }
}

/** A minimal but real collection, so the store's put/get round trip survives. */
const COLLECTION: SgfCollection = parseSgf('(;GM[1]FF[4]CA[UTF-8]SZ[19])')

function seedGame(store: ReturnType<typeof createGameStore>, id: string): void {
  store.put({
    game: {
      id,
      meta: {
        boardSize: 19,
        komi: 6.5,
        handicap: 0,
        blackName: 'B',
        whiteName: 'W',
        date: '2026-09-10',
        ruleset: 'japanese',
      },
      setup: { black: [], white: [] },
      moves: [{ number: 1, player: 'black', coord: { x: 3, y: 3 } }],
      branches: [],
      source: 'import',
      contentHash: id,
      importedAt: NOW,
    },
    collection: COLLECTION,
  })
}

describe('analysis repository', () => {
  it('commits chunks and reads back persisted moves and the winrate seed', () => {
    const testDb = createTestDb()
    try {
      const store = createGameStore(testDb.db)
      seedGame(store, 'g1')
      const repository = createAnalysisRepository(testDb.db)

      repository.commitChunk('g1', [
        row(1, { winrate: 0.61 }),
        row(2, { winrate: 0.62 }),
      ])

      expect(repository.persistedMoves('g1')).toEqual([1, 2])
      expect(repository.winrateAt('g1', 2)).toBe(0.62)
      expect(repository.winrateAt('g1', 3)).toBeUndefined()
    } finally {
      testDb.cleanup()
    }
  })

  it('rowsFor reads every persisted row in move order — the profile derivation’s reader', () => {
    const testDb = createTestDb()
    try {
      const store = createGameStore(testDb.db)
      seedGame(store, 'g1')
      const repository = createAnalysisRepository(testDb.db)

      repository.commitChunk('g1', [
        row(1, { winrate: 0.61, winrateLoss: 0.02, topCandidateCoord: 'Q16' }),
        row(2, { winrate: 0.62, winrateLoss: -0.01, topCandidateCoord: null }),
      ])

      expect(repository.rowsFor('g1')).toEqual([
        {
          moveNumber: 1,
          player: 'white',
          winrate: 0.61,
          scoreLead: 1.5,
          winrateLoss: 0.02,
          topCandidateCoord: 'Q16',
          topCandidateWinrate: 0.55,
        },
        {
          moveNumber: 2,
          player: 'black',
          winrate: 0.62,
          scoreLead: 1.5,
          winrateLoss: -0.01,
          topCandidateCoord: null,
          topCandidateWinrate: 0.55,
        },
      ])
      expect(repository.rowsFor('g2')).toEqual([])
    } finally {
      testDb.cleanup()
    }
  })

  it('an empty chunk is a no-op, not a transaction ceremony', () => {
    const testDb = createTestDb()
    try {
      const store = createGameStore(testDb.db)
      seedGame(store, 'g1')
      const repository = createAnalysisRepository(testDb.db)
      repository.commitChunk('g1', [])
      expect(repository.persistedMoves('g1')).toEqual([])
    } finally {
      testDb.cleanup()
    }
  })

  it('markDone lands rows and the ledger flip together', () => {
    const testDb = createTestDb()
    try {
      const store = createGameStore(testDb.db)
      seedGame(store, 'g1')
      const repository = createAnalysisRepository(testDb.db)

      repository.markDone('g1', [row(1)], NOW)

      expect(repository.ledger().get('g1')).toBe('done')
      expect(repository.persistedMoves('g1')).toEqual([1])
    } finally {
      testDb.cleanup()
    }
  })

  it('walks the ledger state machine a run drives', () => {
    const testDb = createTestDb()
    try {
      const store = createGameStore(testDb.db)
      seedGame(store, 'g1')
      const repository = createAnalysisRepository(testDb.db)
      const ledger = (): string | undefined => repository.ledger().get('g1')

      expect(ledger()).toBeUndefined()
      repository.markPending('g1', NOW)
      expect(ledger()).toBe('pending')
      repository.markFailed('g1', NOW)
      expect(ledger()).toBe('failed')
      // A failed game is retried next run: pending again, then done.
      repository.markPending('g1', NOW)
      expect(ledger()).toBe('pending')
      repository.markDone('g1', [], NOW)
      expect(ledger()).toBe('done')
    } finally {
      testDb.cleanup()
    }
  })

  it('keeps rows isolated per game', () => {
    const testDb = createTestDb()
    try {
      const store = createGameStore(testDb.db)
      seedGame(store, 'g1')
      seedGame(store, 'g2')
      const repository = createAnalysisRepository(testDb.db)

      repository.commitChunk('g1', [row(1), row(2)])
      repository.commitChunk('g2', [row(1, { winrate: 0.9 })])

      expect(repository.persistedMoves('g1')).toEqual([1, 2])
      expect(repository.persistedMoves('g2')).toEqual([1])
      expect(repository.winrateAt('g2', 1)).toBe(0.9)
    } finally {
      testDb.cleanup()
    }
  })

  it('rows and ledger survive a real close and reopen', () => {
    const testDb = createTestDb()
    try {
      const store = createGameStore(testDb.db)
      seedGame(store, 'g1')
      createAnalysisRepository(testDb.db).markDone(
        'g1',
        [row(1, { winrate: 0.7 }), row(2, { winrate: 0.71 })],
        NOW,
      )
      testDb.close()

      const reopened = openDatabase(testDb.file)
      try {
        const repository = createAnalysisRepository(reopened)
        expect(repository.persistedMoves('g1')).toEqual([1, 2])
        expect(repository.winrateAt('g1', 2)).toBe(0.71)
        expect(repository.ledger().get('g1')).toBe('done')
      } finally {
        reopened.close()
      }
    } finally {
      testDb.cleanup()
    }
  })

  it('deleting the game cascades its rows and ledger entry away', () => {
    const testDb = createTestDb()
    try {
      const store = createGameStore(testDb.db)
      seedGame(store, 'g1')
      const repository = createAnalysisRepository(testDb.db)
      repository.markDone('g1', [row(1)], NOW)

      store.delete('g1')

      expect(repository.persistedMoves('g1')).toEqual([])
      expect(repository.ledger().get('g1')).toBeUndefined()
    } finally {
      testDb.cleanup()
    }
  })
})
