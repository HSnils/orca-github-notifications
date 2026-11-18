// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. The worker reads GitHub itself, so these show the no-token and empty states.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  fresh: {}
})
