import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type RoomSnapshot } from '../../lib/api';
import { useApp } from '../../state/AppState';
import { Field, Modal, Toggle } from '../ui';

interface Props {
  room: RoomSnapshot;
  onClose: () => void;
  onSaved: () => void;
}

export function RoomSettingsDialog({ room, onClose, onSaved }: Props) {
  const { toast } = useApp();
  const navigate = useNavigate();
  const [name, setName] = useState(room.name);
  const [topic, setTopic] = useState(room.topic ?? '');
  const [isPublic, setIsPublic] = useState(room.isPublic);
  const [controlHosts, setControlHosts] = useState(room.controlMode === 'hosts');
  const [queueHosts, setQueueHosts] = useState(room.queueMode === 'hosts');
  const [waitForBuffer, setWaitForBuffer] = useState(room.waitForBuffer);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/rooms/${room.id}`, {
        name: name.trim() || room.name,
        topic: topic.trim() || null,
        isPublic,
        controlMode: controlHosts ? 'hosts' : 'everyone',
        queueMode: queueHosts ? 'hosts' : 'everyone',
        waitForBuffer,
      });
      toast('Room settings saved', 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save', 'error');
      setBusy(false);
    }
  };

  const destroy = async () => {
    if (!confirm(`Delete "${room.name}"? The queue and chat history go with it.`)) return;
    try {
      await api.del(`/rooms/${room.id}`);
      navigate('/');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the room', 'error');
    }
  };

  return (
    <Modal
      title="Room settings"
      onClose={onClose}
      footer={
        <>
          <button className="btn danger" onClick={destroy} style={{ marginRight: 'auto' }}>
            Delete room
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? <span className="spinner" /> : 'Save'}
          </button>
        </>
      }
    >
      <Field label="Room name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      </Field>
      <Field label="Topic">
        <input
          className="input"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          maxLength={200}
          placeholder="What are we watching?"
        />
      </Field>

      <div>
        <Toggle
          checked={isPublic}
          onChange={setIsPublic}
          label="Listed publicly"
          hint="Anyone with an account can find and join this room."
        />
        <Toggle
          checked={controlHosts}
          onChange={setControlHosts}
          label="Only hosts control playback"
          hint="Play, pause, seek and skip are limited to you and your hosts."
        />
        <Toggle
          checked={queueHosts}
          onChange={setQueueHosts}
          label="Only hosts change the queue"
          hint="Members can watch and chat but not add or remove videos."
        />
        <Toggle
          checked={waitForBuffer}
          onChange={setWaitForBuffer}
          label="Wait for everyone"
          hint="Pause automatically while someone is still buffering, then resume together."
        />
      </div>
    </Modal>
  );
}
