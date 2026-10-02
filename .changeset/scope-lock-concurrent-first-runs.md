---
"@paliontech/palm": patch
---

Two or more palm commands started together in a project could fail with `ENOENT` on `.palm/local`: a run that finished removed the empty `.palm/local/` directory while another run was creating its lock in it. palm now keeps `.palm/local/` after a run (it is ignored by git and holds only the lock while palm runs), and a lock whose directory disappears at that moment is created again.
