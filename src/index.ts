import papa from 'papaparse'
import _ from 'lodash'

interface DocumentIDScore {
  documentID: string
  score: number
}

export function analyze(s: string): string[] {
  return s
    .split(/[',、　 ​']+/)
    .map(s => s.toLowerCase())
    .map(s => s.replace(PUNCTUATIONS, ''))
    .filter(s => STOP_WORDS.indexOf(s) === -1)
    .filter(s => s.length > 0)
}

export interface SearchResult {
  hits: Hit[]
  count: number
}

export interface Hit {
  id: string
  score: number
  source: Record<string, unknown>
}

export interface SearchOptions {
  from: number
  size: number
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  from: 0,
  size: 10,
}

interface TermStat {
  termFrequencies: Record<string, number>
}

const DOCUMENTS_FILE_EXTENSION = 'dcs'
const TERM_STATS_FILE_EXTENSION = 'tst'
const SHARD_COUNT_FILE_NAME = 'shard_count'

const PUNCTUATIONS = /!"#\$%&\(\)\*\+,-.\/:;<=>\?@[\\]\^_`{\|}~]/
const STOP_WORDS = [
  'a',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'if',
  'in',
  'into',
  'is',
  'it',
  'no',
  'not',
  'of',
  'on',
  'or',
  's',
  'such',
  't',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'will',
  'with',
  'www',
]

export class Index {
  indexName: string
  baseURL: string
  documents: Record<string, Record<string, unknown>>
  termStats: Record<string, TermStat>
  shardCount: number

  constructor(indexName: string, baseURL: string) {
    this.indexName = indexName
    this.baseURL = baseURL
    this.documents = {}
    this.termStats = {}
    this.shardCount = 0
  }

  async load(): Promise<void> {
    await this.loadShardCount()
  }

  async loadShardCount() {
    const url = `${this.baseURL}/${this.indexName}/${SHARD_COUNT_FILE_NAME}`
    const response = await fetch(url)
    const text = await response.text()
    this.shardCount = parseInt(text)
  }

  async search(query: string, opts: SearchOptions = DEFAULT_SEARCH_OPTIONS): Promise<SearchResult> {
    const tokens = analyze(query)

    for (const token of tokens) {
      const shardID = this.calculateShardID(token)
      await this.loadTermStatsFromShard(shardID)
    }

    const matchedDocumentIDs = await this.findDocuments(tokens)
    const sortedDocumentIDScores = await this.sortDocuments(matchedDocumentIDs, tokens)
    const count = sortedDocumentIDScores.length
    const hits = await this.fetchHits(sortedDocumentIDScores, opts.from, opts.size)
    return {
      hits,
      count,
    }
  }

  calculateShardID(s: string): number {
    const Q = new Uint32Array(1)
    const result = new Uint32Array(1)

    Q[0] = 123456789
    result[0] = 0

    let cc = new Uint32Array(1)
    for (const c of s) {
      cc[0] = c.charCodeAt(0)
      result[0] += Q[0] + cc[0] * cc[0]
    }

    result[0] = Math.imul(result[0], Q[0])
    const shardCount = new Uint32Array(1)
    shardCount[0] = this.shardCount
    result[0] %= shardCount[0]

    return result[0]
  }

  async loadTermStatsFromShard(shardID: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.baseURL}/${this.indexName}/${shardID}/${TERM_STATS_FILE_EXTENSION}`
      fetch(url)
        .then(async response => {
          await this.loadTermStatsFromResponse(response)
          resolve()
        })
        .catch((e: Error) => {
          reject(e)
        })
    })
  }

  async loadTermStatsFromResponse(response: Response): Promise<void> {
    return new Promise((resolve, reject) => {
      response
        .text()
        .then(async text => {
          papa.parse(text, {
            complete: result => {
              for (const record of result.data as string[][]) {
                if (record.length < 2) {
                  continue
                }

                const term = record[0]
                let termStat: TermStat

                if (term in this.termStats) {
                  termStat = this.termStats[term]
                } else {
                  termStat = {
                    termFrequencies: {},
                  }
                }

                const termFrequencies = record[1].split(' ')
                for (const v of termFrequencies) {
                  const vv = v.split(':')
                  const id = vv[0]
                  const frequency = vv[1]
                  termStat.termFrequencies[id] = parseInt(frequency)
                }

                this.termStats[term] = termStat
              }
            },
          })
          resolve()
        })
        .catch(e => reject(e))
    })
  }

  async findDocuments(tokens: string[]): Promise<string[]> {
    let documentIDsSet = new Set<string>()

    for (const token of tokens) {
      if (!(token in this.termStats)) {
        continue
      }

      const termStat = this.termStats[token]

      let documentIDs = []
      for (const documentID in termStat.termFrequencies) {
        documentIDs.push(documentID)
      }

      if (documentIDsSet.size === 0) {
        for (const documentID of documentIDs) {
          documentIDsSet.add(documentID)
        }
      } else if (documentIDsSet.size === 1) {
        break
      } else {
        const newDocumentIDsSet = new Set<string>()
        for (const documentID of documentIDs) {
          if (documentIDsSet.has(documentID)) {
            newDocumentIDsSet.add(documentID)
          }
        }
        documentIDsSet = newDocumentIDsSet
      }
    }

    return Array.from(documentIDsSet)
  }

  async sortDocuments(matchedDocumentIDs: string[], tokens: string[]): Promise<DocumentIDScore[]> {
    const documentIDScores: DocumentIDScore[] = []

    for (const documentID of matchedDocumentIDs) {
      const score = await this.calculateScore(documentID, tokens)
      documentIDScores.push({ documentID, score })
    }

    return documentIDScores.sort((a, b) => a.score - b.score)
  }

  async fetchHits(documentIDScores: DocumentIDScore[], from: number, size: number): Promise<Hit[]> {
    let n = documentIDScores.length
    let hits: Hit[] = []
    let cnt = 0

    if (size === 0 || from >= n) {
      return hits
    }
    if (n > size) {
      n = size
    }

    for (const documentIDScore of documentIDScores) {
      if (cnt >= size) {
        break
      }

      const source = await this.fetch(documentIDScore.documentID)
      hits.push({
        id: documentIDScore.documentID,
        score: documentIDScore.score,
        source,
      })

      cnt += 1
    }

    return hits
  }

  fetch(documentID: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.shardCount === 0) {
        reject()
        return
      }

      const shardID = this.calculateShardID(documentID)
      this.loadDocumentsFromShard(shardID).then(() => {
        if (documentID in this.documents) {
          resolve(this.documents[documentID])
        } else {
          reject()
        }
      })
    })
  }

  async calculateScore(documentID: string, tokens: string[]): Promise<number> {
    let score = 0.0

    for (const token of tokens) {
      let tf = await this.termFrequency(documentID, token)
      score += tf * this.inverseDocumentFrequency(token)
    }

    return score
  }

  async termFrequency(documentID: string, token: string): Promise<number> {
    const termStat = await this.fetchTermStat(token)
    if (!termStat) {
      return 0.0
    }

    if (documentID in termStat.termFrequencies) {
      return termStat.termFrequencies[documentID]
    }

    return 0.0
  }

  async fetchTermStat(token: string): Promise<TermStat | null> {
    if (!(token in this.termStats)) {
      const shardID = this.calculateShardID(token)
      await this.loadTermStatsFromShard(shardID)
    }

    if (token in this.termStats) {
      return this.termStats[token]
    }

    return null
  }

  async loadDocumentsFromShard(shardID: number): Promise<void> {
    return new Promise((resolve, reject) => {
      fetch(`${this.baseURL}/${this.indexName}/${shardID}/${DOCUMENTS_FILE_EXTENSION}`)
        .then(async response => {
          await this.loadDocumentsFromResponse(response)
          resolve()
        })
        .catch((e: Error) => {
          reject(e)
        })
    })
  }

  async loadDocumentsFromResponse(response: Response): Promise<void> {
    return new Promise((resolve, reject) => {
      response
        .text()
        .then(async text => {
          papa.parse(text, {
            complete: result => {
              let headers: string[] = []

              for (const record of result.data as string[][]) {
                if (headers.length === 0) {
                  headers = record
                  continue
                }

                const documentID = record[0]
                const document = documentFromRecord(headers, record)
                this.documents[documentID] = document
              }
            },
          })
          resolve()
        })
        .catch(e => reject(e))
    })
  }

  inverseDocumentFrequency(token: string): number {
    const numberOfDocuments = Object.keys(this.documents).length
    const numberOfDocumentsContainingToken = this.documentFrequency(token)
    const frequency = numberOfDocuments / numberOfDocumentsContainingToken
    return Math.log10(frequency)
  }

  documentFrequency(token: string): number {
    return this.termStats[token].termFrequencies.length
  }
}

function documentFromRecord(headers: string[], record: string[]): Record<string, unknown> {
  const document = {}

  for (let i = 0; i < headers.length; i++) {
    if (i === 0) {
      continue
    }
    _.set(document, headers[i], record[i])
  }

  return document
}
