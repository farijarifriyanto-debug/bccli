import { expect, test } from 'vitest'
import type { ChatMessage } from '../src/provider'
import { contentText, imageUserMessage, responseInputFromMessages } from '../src/provider'

test('user parts convert to Responses input_text/input_image items', () => {
  const message: ChatMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'see this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ],
  }
  expect(responseInputFromMessages([message])).toEqual([
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'see this' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
      ],
    },
  ])
})

test('string user and system messages pass through unchanged', () => {
  expect(responseInputFromMessages([{ role: 'user', content: 'hi' }, { role: 'system', content: 'sys' }])).toEqual([
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'sys' },
  ])
})

test('contentText extracts the text parts and marks images', () => {
  expect(contentText('plain')).toBe('plain')
  expect(contentText([{ type: 'text', text: 'see this' }, { type: 'image_url', image_url: { url: 'data:x' } }])).toBe(
    'see this [image]',
  )
  expect(contentText([{ type: 'image_url', image_url: { url: 'data:x' } }])).toBe('[image]')
})

test('imageUserMessage captions the paths and carries data-url parts', () => {
  const message = imageUserMessage([
    { mediaType: 'image/png', data: 'AAA', path: 'logo.png' },
    { mediaType: 'image/jpeg', data: 'BBB', path: 'photo.jpg' },
  ])
  expect(message.role).toBe('user')
  const parts = (message as { content: { type: string; text?: string; image_url?: { url: string } }[] }).content
  expect(parts[0]).toEqual({ type: 'text', text: 'Images read from logo.png, photo.jpg.' })
  expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } })
  expect(parts[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } })
})
