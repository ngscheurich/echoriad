# Cancel container builds daemon-side

Status: needs-triage

Observed during host testing of issue 03 on macOS (Docker via colima). When Echoriad cancels a build or pi shuts down, it terminates the Gondolin subprocess group and removes its temporary output directory. For builds with `postBuild.commands` on macOS, the actual build runs in a container owned by the Docker daemon inside the colima VM. Killing the `docker` client does not stop the daemon's container, so the cancelled build keeps running headless — consuming VM CPU until its steps finish — before `--rm` removes it.

The cancellation guarantees issue 03 implemented hold: no import runs, no authorization metadata is written, and Echoriad's temporary output directory is removed. The gap is purely resource leakage in the VM. Reproduce: start a build whose `postBuild.commands` include `sleep 120`, quit pi mid-build, then run `colima ssh -- ps aux | grep "sleep 120"` — the sleep survives.

The fix belongs in Gondolin: container builds need daemon-side cancellation, such as client-death detection, a cancellation API that runs `docker stop`, or replacing the `--rm` attachment with a lifecycle the builder controls. Echoriad reaching into Docker state to find and kill Gondolin's containers would cross the delegation boundary in `docs/adrs/0001-delegate-guest-image-builds-to-gondolin.md`.

Until this lands, native builds (no `postBuild.commands`) cancel cleanly because all work lives in the terminated process group, and a cancelled container build can be cleared manually with `docker rm -f` or a colima restart. The user documentation (issue 05) should mention the leak if it remains at release time.
