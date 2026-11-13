// What goes with a project when it is deleted (2026-11-14).
//
// A project owns two things outside its own record: its standing build/test
// loops, and the assignment of the agents on its team. Deleting only the
// record left both behind — loops that kept firing at a project that was gone,
// and agents assigned to nothing. The loops are removed with it. The agents
// are the user's own work and are kept: they go back to the library.

import { list as listAgents, update as updateAgent, type StoredAgent } from './agents'
import { removeProject } from './projects'
import { getSchedules, removeSchedule, type Schedule } from './schedules'

export interface RemovalScope {
  /** Standing loops that are removed with the project. */
  loops: number
  /** Agents on its team that go back to the library. */
  agents: number
  /** The room was talked in: its conversation is filed in the vault first. */
  conversation: boolean
}

const mine = (projectId: string) => (s: Pick<Schedule, 'projectId'>) => s.projectId === projectId
const onTeam = (projectId: string) => (a: Pick<StoredAgent, 'assignedTo' | 'system'>) =>
  !a.system && (a.assignedTo ?? '') === projectId

/** Pure: how much of `schedules` and `agents` belongs to this project. */
export function removalScope(
  projectId: string,
  schedules: readonly Pick<Schedule, 'projectId'>[],
  agents: readonly Pick<StoredAgent, 'assignedTo' | 'system'>[],
  messages = 0,
): RemovalScope {
  return {
    loops: schedules.filter(mine(projectId)).length,
    agents: agents.filter(onTeam(projectId)).length,
    conversation: messages > 0,
  }
}

/** The one sentence the Delete confirm shows: everything that will happen. */
export function removalNote(scope: RemovalScope, alsoTrash: boolean): string {
  const loops = scope.loops > 0 ? ` with its ${scope.loops} ${scope.loops === 1 ? 'loop' : 'loops'}` : ''
  const kept = [
    scope.agents > 0
      ? `its ${scope.agents} ${scope.agents === 1 ? 'agent goes' : 'agents go'} back to the library`
      : '',
    scope.conversation ? 'its conversation is filed in your vault' : '',
  ].filter(Boolean)
  const head = `removes it from SC Prism${loops}${kept.length > 0 ? `; ${kept.join(' and ')}` : ''}`
  return alsoTrash
    ? `${head}${loops || kept.length > 0 ? ',' : ''} and moves its folder to the Trash — you can put it back from the Finder`
    : `${head} — the folder on disk is untouched`
}

/** Remove the project, its loops, and its agents' assignment — in that order
 *  of safety: what points AT the project goes first, the project last. */
export function removeProjectWithItsThings(projectId: string): Pick<RemovalScope, 'loops' | 'agents'> {
  const loops = getSchedules().filter(mine(projectId))
  const agents = listAgents().filter(onTeam(projectId))
  for (const s of loops) removeSchedule(s.id)
  for (const a of agents) updateAgent(a.id, { assignedTo: '' })
  removeProject(projectId)
  return { loops: loops.length, agents: agents.length }
}
