// SC Prism — "Team" rail panel (P4-2): who's on the active project's team and
// their live status. The run/event FEED that used to live here now renders in
// the engine console at the bottom of the chat column (a better home — it's the
// "what happened on this project" log), so the rail stays compact. Everything
// comes straight out of `projectActivity` (pure, lib/activity.ts) — this
// component only renders the team; it never invents a row.
import { useAgents } from '../lib/agents'
import { useApp } from '../store/AppStore'
import { projectActivity } from '../lib/activity'
import type { Project } from '../lib/projects'
import './LiveActivity.css'

export default function LiveActivity({ project }: { project: Project }) {
  const agents = useAgents()
  const { state } = useApp()
  const runningId = project.status === 'running' ? project.id : undefined
  const { team } = projectActivity(project, agents, state.verdicts, runningId)

  return (
    <div className="liveact">
      <div className="liveact__sectionhead">
        <span className="liveact__kicker">Team</span>
      </div>
      <div className="liveact__team">
        {team.map(({ agent, activity }) => (
          <div key={agent.id} className="liveact__teamrow">
            <span className={`liveact__dot liveact__dot--${activity.state}`} />
            <span className="liveact__teamname">{agent.name}</span>
            <span className="liveact__modelchip mono">{agent.model}</span>
            <span className="liveact__teamactivity mono">{activity.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
