// Фото покупателя в отзыве или сообщении чата: миниатюры и то, что на них увидел агент.
// Картинка идёт через сервер (/api/reviews/media/<id>) — ключи площадок в браузер не попадают.
export type BuyerMediaItem = { id: number; kind: 'photo' | 'video'; note: string | null; viewable: boolean; error: string | null };

export function BuyerMedia({ media, mpName }: { media?: BuyerMediaItem[]; mpName: string }) {
  if (!media?.length) return null;
  const notes = media.filter(m => m.note);
  return (
    <div className="rv-media">
      <div className="rv-media-row">
        {media.map((m, i) => m.viewable ? (
          <a key={m.id} className="rv-media-thumb" href={`/api/reviews/media/${m.id}`} target="_blank" rel="noreferrer"
            title={m.kind === 'video' ? 'Кадр из видео покупателя — открыть крупно' : 'Фото покупателя — открыть крупно'}>
            <img src={`/api/reviews/media/${m.id}`} alt={m.note || `Фото покупателя ${i + 1}`} loading="lazy" />
            {m.kind === 'video' && <span className="rv-media-tag">видео</span>}
          </a>
        ) : (
          <span key={m.id} className="rv-media-thumb rv-media-thumb--none" title={`Видео покупателя — посмотреть можно в кабинете ${mpName}`}>видео</span>
        ))}
      </div>
      {notes.length > 0 && (
        <div className="rv-media-note">
          <b>Агент увидел на фото:</b>{' '}
          {notes.length === 1 ? notes[0].note : notes.map((m, i) => <span key={m.id}>{i > 0 && ' '}{media.indexOf(m) + 1}) {m.note}</span>)}
        </div>
      )}
      {media.some(m => m.error) && <div className="rv-media-note rv-media-note--bad">Часть фото агент открыть не смог — посмотрите их в кабинете {mpName}.</div>}
    </div>
  );
}
