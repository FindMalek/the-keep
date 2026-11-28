import type { MusicStats, ReadingStats, Snapshot } from "../../shared/types";
import { Chip } from "../components/chip";
import { PageHeader } from "../components/page-header";
import { BoxFoot, Empty, Link, Panel, Subhead } from "../components/panel";
import { since } from "../lib/time";

const count = (value: number): string => value.toLocaleString("en-US");

function albumHref(link: string | null, id: string | undefined): string | null {
  return link && id ? `${link}/app/#/album/${id}/show` : null;
}

function NowPlaying({ music, link }: { music: MusicStats; link: string | null }) {
  return (
    <Panel id="playing" title="now playing" span={12} meta={music.nowPlaying.length ? `${music.nowPlaying.length} listening` : "navidrome"} href={link ?? undefined}>
      {music.nowPlaying.length === 0 ? (
        <p className="muted">
          nothing playing{music.lastImport ? ` · last import ${since(Date.parse(music.lastImport.at))}` : ""}
          {link && (
            <>
              {" · "}
              <Link href={link}>open navidrome</Link>
            </>
          )}
        </p>
      ) : (
        <ul className="list">
          {music.nowPlaying.map((entry) => (
            <li className="line" key={`${entry.user}-${entry.title}`}>
              <span className="ellipsis">
                <Chip tone="solid">live</Chip> {entry.title} <span className="muted">· {entry.artist} · {entry.album}</span>
              </span>
              <span className="muted small">
                {entry.user} · {entry.player}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function AlbumList({ albums, link, aside }: { albums: { id?: string; album: string; artist: string }[]; link: string | null; aside: (index: number) => string }) {
  return (
    <ul className="albums">
      {albums.map((album, index) => {
        const href = albumHref(link, album.id);
        const body = (
          <>
            <span className="album-title ellipsis">{album.album}</span>
            <span className="album-artist ellipsis">{album.artist}</span>
            <span className="album-aside">{aside(index)}</span>
          </>
        );
        return (
          <li key={`${album.artist}-${album.album}`}>
            {href ? (
              <a className="album row-link" href={href} target="_blank" rel="noreferrer">
                {body}
              </a>
            ) : (
              <span className="album">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Library({ music, link, span }: { music: MusicStats; link: string | null; span: 8 | 12 }) {
  const imported = music.lastImport;
  return (
    <Panel id="library" title="library" span={span} meta="navidrome" href={link ?? undefined}>
      {!music.reachable ? (
        <Empty>navidrome not reachable</Empty>
      ) : (
        <>
          <dl className="figures">
            <div>
              <dt>tracks</dt>
              <dd>{count(music.songs)}</dd>
            </div>
            <div>
              <dt>albums</dt>
              <dd>{count(music.albums)}</dd>
            </div>
            <div>
              <dt>artists</dt>
              <dd>{count(music.artists)}</dd>
            </div>
          </dl>
          <Subhead>recently added</Subhead>
          <AlbumList albums={music.recentlyAdded} link={link} aside={(index) => String(music.recentlyAdded[index]?.year ?? "")} />
          <Subhead>most played</Subhead>
          {music.frequent && music.frequent.length > 0 ? (
            <AlbumList albums={music.frequent} link={link} aside={(index) => `${music.frequent?.[index]?.plays ?? 0} plays`} />
          ) : (
            <p className="small muted">{music.frequent ? "no play counts yet: navidrome records them as you listen" : "not collected by this server version yet"}</p>
          )}
          <BoxFoot>
            {imported ? (
              <>
                last import {since(Date.parse(imported.at))}: {imported.imported} tracks
                {imported.leftInInbox > 0 && <span className="level-warn"> · {imported.leftInInbox} left in inbox</span>}
              </>
            ) : (
              "the inbox is checked every 11 min"
            )}
          </BoxFoot>
        </>
      )}
    </Panel>
  );
}

function Reading({ reading, link }: { reading: ReadingStats; link: string | null }) {
  return (
    <Panel id="reading" title="reading" span={4} meta={`${count(reading.unread)} unread · ${reading.feeds} feeds`} href={link ?? undefined}>
      {!reading.reachable ? (
        <Empty>miniflux not reachable</Empty>
      ) : reading.latest.length === 0 ? (
        <Empty action={link ? <Link href={link}>{reading.feeds === 0 ? "add feeds in miniflux" : "open miniflux"}</Link> : undefined}>
          {reading.feeds === 0 ? "no feeds yet" : "all caught up"}
        </Empty>
      ) : (
        <ul className="articles">
          {reading.latest.map((entry) => (
            <li key={entry.url}>
              <a className="article row-link" href={entry.url} target="_blank" rel="noreferrer">
                <span className="article-title">{entry.title}</span>
                <span className="article-meta">
                  {entry.feed.toLowerCase()} · {since(Date.parse(entry.publishedAt))}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** What i listen to and read, from navidrome and miniflux. */
export function MediaPage({ snapshot }: { snapshot: Snapshot }) {
  const { music, reading } = snapshot.home;
  const hasReading = reading.reachable && (reading.feeds > 0 || reading.latest.length > 0);
  return (
    <>
      <PageHeader title="media" meta={`${count(music.songs)} tracks · ${count(reading.unread)} unread`} />
      <div className="grid">
        <NowPlaying music={music} link={snapshot.links.navidrome} />
        <Library music={music} link={snapshot.links.navidrome} span={hasReading ? 8 : 12} />
        {hasReading && <Reading reading={reading} link={snapshot.links.miniflux} />}
      </div>
    </>
  );
}
