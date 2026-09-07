# Consider filtering the image build environment

Status: needs-triage

The initial automatic build-config release preserves Gondolin CLI behavior by passing the host process environment to the build subprocess. Native Linux `postBuild.commands` can therefore receive host environment variables while executing in the rootfs chroot.

The approval prompt and user documentation must warn about this exposure when post-build commands are present.

Consider replacing environment inheritance with a documented allowlist if credential exposure outweighs compatibility with Gondolin, Docker, Podman, network proxies, custom helper discovery, and existing build workflows. The allowlist must be tested against every supported Gondolin build path before adoption.

## Comments
