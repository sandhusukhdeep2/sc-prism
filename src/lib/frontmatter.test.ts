import { describe, expect, it } from 'vitest'
import { splitFrontmatter } from './frontmatter'

// A vault note's YAML frontmatter is metadata, not prose. The Vault preview
// used to pour it into the first paragraph: "--- name: archivist description:
// manages … model: local skills: [...] ---" (seen 2026-11-11).
describe('splitFrontmatter', () => {
  it('lifts a leading --- block into key/value pairs and leaves the body', () => {
    const md = '---\nname: archivist\ndescription: manages the lifecycle of vault reports\nmodel: local\nskills: [file-management, archiving]\n---\n\nResponsibility: own the lifecycle.\n'
    expect(splitFrontmatter(md)).toEqual({
      meta: [
        ['name', 'archivist'],
        ['description', 'manages the lifecycle of vault reports'],
        ['model', 'local'],
        ['skills', '[file-management, archiving]'],
      ],
      body: 'Responsibility: own the lifecycle.\n',
    })
  })
  it('a note with no frontmatter is all body', () => {
    expect(splitFrontmatter('# Title\n\ntext')).toEqual({ meta: [], body: '# Title\n\ntext' })
  })
  it('an unterminated block is not frontmatter — nothing is hidden', () => {
    const md = '---\nname: x\nno closing fence'
    expect(splitFrontmatter(md)).toEqual({ meta: [], body: md })
  })
  it('a value may contain colons; a line with no key stays out of the pairs but the block still lifts', () => {
    expect(splitFrontmatter('---\nurl: https://example.com/a:b\n- stray\n---\nbody').meta).toEqual([['url', 'https://example.com/a:b']])
  })
})
