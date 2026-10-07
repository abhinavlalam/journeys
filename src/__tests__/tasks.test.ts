import { describe, expect, it } from 'vitest'
import { collectTagLines } from '../tags'
import { readTasks, tasksByWhen, withDone } from '../tasks'

/** Every `#task` line, by when it is due, and done written into the line itself. */

const typeOf = (name: string) => (name === 'due' ? ('date' as const) : name === 'project' ? ('backlink' as const) : ('text' as const))
const note = { path: 'Projects/Harbour.md', absolutePath: '/v/Projects/Harbour.md', name: 'Harbour' }
const raw = [
  'Notes on the harbour plan.',
  '- #task call Mira about the slip due:: 2026-10-05',
  '- #task book the survey due:: 2026-10-07 project:: [[Harbour]]',
  '- #task order rope due:: 2026-10-09',
  '- #task paint the hull due:: 2026-10-12',
  '- #task sort the photos',
  '- #task send the invoice due:: 2026-10-01 status:: done',
].join('\n')
const tasks = readTasks([{ note, lines: collectTagLines(raw, 'task') }], typeOf)
/** A Wednesday, in a week that starts on Monday. */
const grouped = tasksByWhen(tasks, '2026-10-07', 1)
const words = (when: Parameters<typeof grouped.get>[0]) => grouped.get(when)!.map((task) => task.text.split(' ').slice(2, 4).join(' '))

describe('tasks', () => {
  it('reads each line’s due day, project and whether it is done, with where it is', () => {
    expect(tasks.map((one) => [one.at, one.due, one.project, one.done])).toEqual([
      [1, '2026-10-05', null, false],
      [2, '2026-10-07', '[[Harbour]]', false],
      [3, '2026-10-09', null, false],
      [4, '2026-10-12', null, false],
      [5, null, null, false],
      [6, '2026-10-01', null, true],
    ])
  })

  it('groups them by when they are due: this week runs to the end of the locale’s week', () => {
    expect(words('Overdue')).toEqual(['call Mira'])
    expect(words('Today')).toEqual(['book the'])
    expect(words('This week')).toEqual(['order rope'])
    // Monday is next week's, so it is later.
    expect(words('Later')).toEqual(['paint the'])
    expect(words('No date')).toEqual(['sort the'])
    // A done task is done, however overdue it was.
    expect(words('Done')).toEqual(['send the'])
    // On Sunday the week is over: Monday is later, not this week.
    expect(tasksByWhen(tasks, '2026-10-11', 1).get('This week')).toEqual([])
  })

  it('marks a line done, over any status, and takes it back, leaving the rest as written', () => {
    const line = '- #task order rope due:: 2026-10-09'
    expect(withDone(line, true, typeOf)).toBe('- #task order rope due:: 2026-10-09 status:: done')
    expect(withDone('- #task order rope status:: doing due:: 2026-10-09', true, typeOf)).toBe('- #task order rope status:: done due:: 2026-10-09')
    expect(withDone('- #task order rope status:: done due:: 2026-10-09', false, typeOf)).toBe('- #task order rope due:: 2026-10-09')
    expect(withDone(line, false, typeOf)).toBe(line)
  })
})
