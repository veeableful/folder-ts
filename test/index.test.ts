import { analyze, Index } from '../src'
import 'isomorphic-fetch'

let index: Index

beforeEach(async () => {
  index = new Index('index', ['https://language-journal.veandco.sg-sin1.upcloudobjects.com', 'jmdict'].join('/'))
  await index.load()
})

describe('analyze "lunar new year"', () => {
  it('works', () => {
    expect(analyze('lunar new year')).toEqual(['lunar', 'new', 'year'])
  })
})

describe('analyze "​再放送"', () => {
  it('works', () => {
    const res = analyze('​再放送')
    expect(res).toEqual(['再放送'])
  })
})

describe('search "bowl"', () => {
  it('works', async () => {
    const start = Date.now()
    const result = await index.search('bowl')
    const end = Date.now()
    expect(result.count).toEqual(102)
    expect(end - start).toBeLessThanOrEqual(5000)
  })
})
