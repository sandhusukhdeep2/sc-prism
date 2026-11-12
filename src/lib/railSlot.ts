// ONE SIDEBAR (2026-11-12).
//
// The app's rail is the one sidebar. On the Work page the rooms — the Manager
// and each project — belong in it, under the places, the way the reference
// the owner pointed at lists its sessions under its actions. The rail owns a
// slot; the Work page draws its rooms INTO it. Other pages leave it empty.
//
// A context rather than a DOM lookup, so the room list moves in the same
// commit the rail mounts in and never paints in two places.
import { createContext } from 'react'

/** The rail's slot for a page's own list, or null when there is no rail
 *  (a page rendered on its own) or it has not mounted yet. */
export const RailSlotContext = createContext<HTMLElement | null>(null)
