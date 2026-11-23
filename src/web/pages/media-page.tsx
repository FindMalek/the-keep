import type { Snapshot } from "../../shared/types";
import { MusicPanel, ReadingPanel } from "../components/home-panels";
import { PageHeader } from "../components/page-header";

/** What i listen to and read, from navidrome and miniflux. */
export function MediaPage({ snapshot }: { snapshot: Snapshot }) {
  return (
    <>
      <PageHeader title="media" meta="music and reading" />
      <div className="grid media">
        <MusicPanel music={snapshot.home.music} link={snapshot.links.navidrome} />
        <ReadingPanel reading={snapshot.home.reading} link={snapshot.links.miniflux} />
      </div>
    </>
  );
}
