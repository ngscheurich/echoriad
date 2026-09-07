# Delegate guest image composition to Gondolin

Echoriad accepts a path to Gondolin's build config and orchestrates Gondolin's builder instead of defining package or image-composition fields of its own. This keeps one composition schema across Gondolin and Echoriad while allowing Echoriad to own the Pi-specific approval, cache, lifecycle, and reporting behavior around automatic builds.
