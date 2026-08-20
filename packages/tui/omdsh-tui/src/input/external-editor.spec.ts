import { describe, expect, it } from 'vitest'
import { editExternally, getEditorCommand } from './external-editor.ts'

describe('getEditorCommand', () => {
  it('prefers $VISUAL over $EDITOR and trims whitespace from both', () => {
    expect(getEditorCommand({ VISUAL: '  code -w  ', EDITOR: 'vim' }, 'darwin')).toBe('code -w')
    expect(getEditorCommand({ VISUAL: '   ', EDITOR: ' vim ' }, 'darwin')).toBe('vim')
    expect(getEditorCommand({ VISUAL: 'vi', EDITOR: 'vim' }, 'darwin')).toBe('vi')
  })

  it('falls back to notepad on Windows and to undefined on POSIX', () => {
    expect(getEditorCommand({}, 'win32')).toBe('notepad')
    expect(getEditorCommand({ VISUAL: '  ', EDITOR: ' ' }, 'win32')).toBe('notepad')
    expect(getEditorCommand({}, 'darwin')).toBeUndefined()
    expect(getEditorCommand({}, 'linux')).toBeUndefined()
  })
})

describe('editExternally', () => {
  it('throws a helpful error when no editor is configured', () => {
    expect(getEditorCommand({}, 'darwin')).toBeUndefined()
    expect(() => editExternally('draft', '')).toThrow('Set $VISUAL or $EDITOR to use the external editor.')
  })

  it('replaces the draft with the saved text when the editor exits successfully', () => {
    const editor = "sh -c 'printf edited > \"$1\"' sh"
    expect(editExternally('draft', editor)).toBe('edited')
  })
})
