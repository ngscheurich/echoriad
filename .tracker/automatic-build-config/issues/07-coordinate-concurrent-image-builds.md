# Coordinate concurrent image builds

Status: needs-triage

Multiple Pi sessions can attempt to build the same uncached fingerprint concurrently. The initial release accepts duplicate work and uses a unique temporary output directory for each build.

Add host-side coordination keyed by build fingerprint. One process should build while other processes wait and then reuse the imported image. Coordinate cache metadata updates as well so concurrent writers cannot discard each other's authorization associations or interfere with active replacement files. The coordination mechanism must recover after the building process exits or crashes without releasing ownership.

This work is deferred from the first automatic build-config release. The initial documentation must disclose that concurrent sessions may duplicate a build and that concurrent metadata updates can cause later reapproval.

## Comments
