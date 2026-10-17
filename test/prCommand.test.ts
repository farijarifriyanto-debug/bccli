import { expect, test } from 'vitest'
import { prReviewPrompt, SLASH_COMMANDS } from '../src/commands'

test('the review prompt drives gh for the current branch when no selector is given', () => {
  const prompt = prReviewPrompt('')
  expect(prompt).toContain('gh pr view')
  expect(prompt).toContain('gh pr diff')
  expect(prompt).toContain('origin/')
  expect(prompt).toMatch(/verdict/i)
  expect(prompt).toMatch(/file:line/)
})

test('a PR selector (number, url, or branch) is passed through to gh', () => {
  const prompt = prReviewPrompt('123')
  expect(prompt).toContain('gh pr view 123')
  expect(prompt).toContain('gh pr diff 123')
  expect(prompt).not.toContain('gh pr view \n')
})

test('the /pr command is registered with a review description', () => {
  const cmd = SLASH_COMMANDS.find((c) => c.name === 'pr')
  expect(cmd).toBeDefined()
  expect(cmd?.description).toMatch(/pull request/i)
})

test('the review prompt forbids mutating the repository state', () => {
  for (const selector of ['', '123']) {
    const prompt = prReviewPrompt(selector)
    expect(prompt).toMatch(/never change the repository state/i)
    expect(prompt).toContain('git show')
    expect(prompt).not.toContain('git checkout')
  }
})
