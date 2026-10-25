import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ProjectLoops } from './Projects'
import { addProject, getProjects, removeProject, useProjects } from '../lib/projects'

// The rail's verify slot (2026-08-29). The interview flow now auto-fills
// `verifyCommand` from the plan's own words, so the user needs somewhere to
// SEE, EDIT and CLEAR it after creation — the create form was the only editor,
// and a wrong auto-extraction would otherwise be permanent. The old static
// "set a verify command first" hint becomes this editable input: same slot,
// same words (as the placeholder), now actionable.
//
// The harness subscribes to the live projects store exactly like the real
// mounts do (ProjectContextPanel receives a store-fresh project), so typing →
// updateProject → re-render is the loop under test, not a static prop.

function LiveLoops({ id }: { id: string }) {
  const { projects } = useProjects()
  const project = projects.find((p) => p.id === id)
  if (!project) return null
  return <ProjectLoops project={project} />
}

function seedProject(verifyCommand: string) {
  for (const p of getProjects().projects) removeProject(p.id)
  return addProject('Node CLI', 'build a CLI', verifyCommand)
}

describe('the rail verify-command slot', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows the stored verify command in an editable input', () => {
    const p = seedProject('npm test')
    render(<LiveLoops id={p.id} />)
    const input = screen.getByLabelText('Verify command') as HTMLInputElement
    expect(input.value).toBe('npm test')
  })

  it('offers "set a verify command first" as the empty placeholder', () => {
    const p = seedProject('')
    render(<LiveLoops id={p.id} />)
    const input = screen.getByLabelText('Verify command') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('set a verify command first')
  })

  it('editing stores the command on the project', () => {
    const p = seedProject('')
    render(<LiveLoops id={p.id} />)
    fireEvent.change(screen.getByLabelText('Verify command'), {
      target: { value: 'npm test' },
    })
    expect(getProjects().projects[0].verifyCommand).toBe('npm test')
  })

  it('clearing the input clears the stored command', () => {
    const p = seedProject('npm test')
    render(<LiveLoops id={p.id} />)
    fireEvent.change(screen.getByLabelText('Verify command'), { target: { value: '' } })
    expect(getProjects().projects[0].verifyCommand).toBe('')
  })

  it('the test-loop button follows the live value: disabled empty, enabled once set', () => {
    const p = seedProject('')
    render(<LiveLoops id={p.id} />)
    const button = screen.getByRole('button', { name: '+ Add test loop' })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Verify command'), {
      target: { value: 'npm test' },
    })
    expect(button).not.toBeDisabled()
  })
})
