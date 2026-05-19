/**
 * AssessmentPlayer.jsx
 *
 * Can be reached two ways:
 *   1. Normal navigation from MyAssessments — user taps a downloaded assessment.
 *      route.params = { assessmentData: {...} }
 *
 *   2. Deep link from SN mobile UI Action.
 *      route.params = { instanceSysId: 'abc123', fromDeepLink: true }
 *      In this case we fetch the payload from the API on mount,
 *      cache it locally, then render as normal.
 */

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Image,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { fetchAssessmentByInstance, submitAssessment, uploadAttachment, completeAssessment } from '../services/assessmentService';
import { assessmentStore } from '../store/assessmentStore';
import { photoStore, blobToBase64 } from '../utils/photoStore';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const CACHE_KEY = (id) => `assessment_instance_${id}`;

async function getCached(instanceSysId) {
  const raw = await AsyncStorage.getItem(CACHE_KEY(instanceSysId));
  return raw ? JSON.parse(raw) : null;
}

async function setCached(instanceSysId, data) {
  await AsyncStorage.setItem(CACHE_KEY(instanceSysId), JSON.stringify(data));
}

// ─────────────────────────────────────────────
// Web file input (rendered via DOM)
// ─────────────────────────────────────────────

function compressImage(dataUrl, maxWidth = 900, targetKB = 50) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxWidth) { height = Math.round(height * maxWidth / width); width = maxWidth; }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      // base64 is ~37% larger than binary, so target = targetKB * 1024 * 1.37
      const maxLen = targetKB * 1024 * 1.37;
      let quality = 0.7;
      let result = canvas.toDataURL('image/jpeg', quality);
      while (result.length > maxLen && quality > 0.2) {
        quality = Math.round((quality - 0.1) * 10) / 10;
        result = canvas.toDataURL('image/jpeg', quality);
      }
      resolve(result);
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function WebFileInput({ value, onChange }) {
  const inputRef = React.useRef(null);
  const [previewUrls, setPreviewUrls] = React.useState({});
  const loadedKeys = React.useRef(new Set());

  const files = Array.isArray(value)
    ? value
    : (value && typeof value === 'string' && (value.startsWith('data:') || value.startsWith('idb:'))
      ? [value] : []);

  // Load preview object-URLs for any idb: entries not yet loaded
  React.useEffect(() => {
    const pending = files.filter(f => f.startsWith('idb:') && !loadedKeys.current.has(f));
    if (!pending.length) return;
    let cancelled = false;
    (async () => {
      const next = {};
      for (const key of pending) {
        loadedKeys.current.add(key);
        const entry = await photoStore.load(key);
        if (entry?.blob && entry.type?.startsWith('image/') && !cancelled) {
          next[key] = URL.createObjectURL(entry.blob);
        }
      }
      if (!cancelled && Object.keys(next).length) setPreviewUrls(prev => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
  }, [files.join('|')]);

  // Revoke object-URLs on unmount to free memory
  React.useEffect(() => {
    return () => Object.values(previewUrls).forEach(u => u && URL.revokeObjectURL(u));
  }, []);

  const handleChange = async (e) => {
    const selected = Array.from(e.target.files);
    if (!selected.length) return;
    const refs = [];
    const newUrls = {};
    for (const file of selected) {
      try {
        const key = await photoStore.save(file);
        refs.push(key);
        loadedKeys.current.add(key);
        if (file.type.startsWith('image/')) newUrls[key] = URL.createObjectURL(file);
      } catch (err) {
        console.warn('photoStore.save failed, falling back to base64', err);
        // Fallback: read as base64 (old behaviour)
        await new Promise(resolve => {
          const reader = new FileReader();
          reader.onload = () => { refs.push(reader.result); resolve(); };
          reader.readAsDataURL(file);
        });
      }
    }
    if (Object.keys(newUrls).length) setPreviewUrls(prev => ({ ...prev, ...newUrls }));
    onChange([...files, ...refs]);
    e.target.value = '';
  };

  const remove = async (idx) => {
    const f = files[idx];
    if (f.startsWith('idb:')) {
      photoStore.remove(f);
      if (previewUrls[f]) { URL.revokeObjectURL(previewUrls[f]); setPreviewUrls(prev => { const n = { ...prev }; delete n[f]; return n; }); }
    }
    onChange(files.filter((_, i) => i !== idx));
  };

  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    ...files.map((f, idx) => {
      const src = f.startsWith('data:image') ? f : (f.startsWith('idb:') ? previewUrls[f] : null);
      return React.createElement('div', { key: idx, style: { display: 'flex', alignItems: 'center', gap: 8 } },
        src
          ? React.createElement('img', { src, style: { width: 64, height: 64, objectFit: 'cover', borderRadius: 6 } })
          : React.createElement('span', { style: { fontSize: 12, color: '#1a6b9a', flex: 1 } }, `✓ File ${idx + 1} attached`),
        React.createElement('button', {
          type: 'button',
          onClick: () => remove(idx),
          style: { background: 'none', border: 'none', color: '#e74c3c', cursor: 'pointer', fontSize: 18, lineHeight: 1 },
        }, '✕'),
      );
    }),
    React.createElement('input', {
      ref: inputRef,
      type: 'file',
      accept: 'image/*,application/pdf',
      multiple: true,
      onChange: handleChange,
      style: { display: 'none' },
    }),
    React.createElement('button', {
      type: 'button',
      onClick: () => inputRef.current?.click(),
      style: {
        padding: '8px 14px',
        backgroundColor: '#f0f4f8',
        border: '1px solid #d0dce8',
        borderRadius: 8,
        cursor: 'pointer',
        fontSize: 13,
        color: '#3a5068',
        textAlign: 'left',
      },
    }, files.length > 0 ? '📎 Add another file' : '📎 Choose file…'),
  );
}

// ─────────────────────────────────────────────
// SKU Dimensions accordion field
// ─────────────────────────────────────────────

const SKU_DIM_BASE = [
  { key: 'num_components', label: 'Number of Components',                               hint: 'Enter a number' },
  { key: 'hardware_parts', label: 'Number of Hardware Parts',                           hint: 'Enter a number' },
  { key: 'assembly_time',  label: 'How long does the product take to fully assemble?',  hint: 'Minutes' },
];

const SKU_DIM_NPI = [
  { key: 'weight_pkg',     label: 'Fully packaged product weight (product inside)',     hint: 'lbs.' },
  { key: 'width_inside',   label: 'Width of packaged product (product inside)',         hint: 'inches' },
  { key: 'depth_inside',   label: 'Depth of packaged product (product inside)',         hint: 'inches' },
  { key: 'height_inside',  label: 'Height of packaged product (product inside)',        hint: 'inches' },
  { key: 'width_outside',  label: 'Width of outer packaging (without product)',         hint: 'inches' },
  { key: 'depth_outside',  label: 'Depth of outer packaging (without product)',         hint: 'inches' },
  { key: 'height_outside', label: 'Height of outer packaging (without product)',        hint: 'inches' },
];

function SkuDimensionsField({ value, onChange, sessionSkus, mandatory, label, isNPI }) {
  const [expanded, setExpanded] = useState({});

  const fields = isNPI ? [...SKU_DIM_BASE, ...SKU_DIM_NPI] : SKU_DIM_BASE;

  const data = React.useMemo(() => {
    try { return value ? JSON.parse(value) : {}; } catch { return {}; }
  }, [value]);

  function update(skuId, fieldKey, fieldVal) {
    const next = { ...data, [skuId]: { ...(data[skuId] || {}), [fieldKey]: fieldVal } };
    onChange(JSON.stringify(next));
  }

  function completedCount(skuId) {
    const d = data[skuId] || {};
    return fields.filter(f => d[f.key]?.toString().trim()).length;
  }

  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {label}
        {mandatory && <Text style={styles.required}> *</Text>}
      </Text>
      {(sessionSkus || []).map(sku => {
        const isOpen = !!expanded[sku.sys_id];
        const done = completedCount(sku.sys_id);
        const total = fields.length;
        const allDone = done === total;
        return (
          <View key={sku.sys_id} style={styles.skuAccordion}>
            <TouchableOpacity
              style={styles.skuAccordionHeader}
              onPress={() => setExpanded(prev => ({ ...prev, [sku.sys_id]: !prev[sku.sys_id] }))}
              activeOpacity={0.8}
            >
              <Text style={styles.skuAccordionTitle}>{isOpen ? '▾' : '▸'} {sku.label}</Text>
              <View style={[styles.skuBadge, allDone && styles.skuBadgeDone]}>
                <Text style={styles.skuBadgeText}>{done}/{total}</Text>
              </View>
            </TouchableOpacity>
            {isOpen && (
              <View style={styles.skuAccordionBody}>
                {fields.map(f => (
                  <View key={f.key} style={{ marginBottom: 12 }}>
                    <Text style={styles.skuFieldLabel}>* {f.label} <Text style={styles.skuFieldHint}>({f.hint})</Text></Text>
                    <TextInput
                      style={styles.textInput}
                      value={(data[sku.sys_id] || {})[f.key] || ''}
                      onChangeText={v => update(sku.sys_id, f.key, v)}
                      placeholder={f.hint}
                      placeholderTextColor="#9aabb8"
                      keyboardType="numeric"
                    />
                  </View>
                ))}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

// ─────────────────────────────────────────────
// Question component
// ─────────────────────────────────────────────

const CHOOSE_SKUS_RE = /choose sku/i;

const CHOICE_ORDER = ['no', 'yes', 'n/a', 'na'];
function sortChoices(choices) {
  if (!choices) return [];
  return [...choices].sort((a, b) => {
    const ai = CHOICE_ORDER.indexOf((a.label || '').toLowerCase());
    const bi = CHOICE_ORDER.indexOf((b.label || '').toLowerCase());
    const aRank = ai === -1 ? 999 : ai;
    const bRank = bi === -1 ? 999 : bi;
    return aRank - bRank;
  });
}

function QuestionField({ question, value, onChange, sessionSkus, isNPI }) {
  const { datatype, choices, name, question: questionText, mandatory } = question;
  const [inputHeight, setInputHeight] = React.useState(80);
  const inputHeightRef = React.useRef(80);
  const webInputRef = React.useRef(null);

  // On web, auto-resize by reading scrollHeight imperatively — no setState loop
  React.useEffect(() => {
    if (Platform.OS !== 'web' || datatype !== 'string') return;
    const el = webInputRef.current;
    if (!el) return;
    const node = el._node || el; // RN Web wraps the DOM element
    if (!node || !node.style) return;
    node.style.height = 'auto';
    node.style.height = Math.max(80, node.scrollHeight) + 'px';
  }, [value, datatype]);

  const label = questionText || name;

  // "SKUs Assembly and Dimensions" macro — per-SKU accordion form
  if (/sku.*assembly|assembly.*dimension|skus\s+assembly/i.test(label) || /sku.*assembly|assembly.*dimension|skus\s+assembly/i.test(name)) {
    return <SkuDimensionsField value={value} onChange={onChange} sessionSkus={sessionSkus} mandatory={mandatory} label={label} isNPI={isNPI} />;
  }

  // "Choose SKUs" — multi-select from the session SKUs regardless of datatype
  if (CHOOSE_SKUS_RE.test(label) || CHOOSE_SKUS_RE.test(name)) {
    const selected = value ? value.split(',').filter(Boolean) : [];
    const toggle = (id) => {
      const next = selected.includes(id)
        ? selected.filter(x => x !== id)
        : [...selected, id];
      onChange(next.join(','));
    };
    const skus = sessionSkus || [];
    return (
      <View style={styles.field}>
        <Text style={styles.label}>
          {label}
          {mandatory && <Text style={styles.required}> *</Text>}
        </Text>
        {skus.length === 0 && (
          <Text style={styles.attachmentNote}>No SKUs selected for this session.</Text>
        )}
        {skus.map((sku) => {
          const isOn = selected.includes(sku.sys_id);
          return (
            <TouchableOpacity
              key={sku.sys_id}
              style={[styles.choiceRow, isOn && styles.choiceSelected]}
              onPress={() => toggle(sku.sys_id)}
              activeOpacity={0.7}
            >
              <View style={[styles.checkbox, isOn && styles.checkboxSelected]}>
                {isOn && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <Text style={[styles.choiceLabel, isOn && styles.choiceLabelSelected]}>
                {sku.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  }

  if (datatype === 'choice') {
    return (
      <View style={styles.field}>
        <Text style={styles.label}>
          {label}
          {mandatory && <Text style={styles.required}> *</Text>}
        </Text>
        {(/(complete this category|want to complete)/i.test(label) ? (choices || []) : sortChoices(choices)).map((choice) => (
          <TouchableOpacity
            key={choice.sys_id}
            style={[styles.choiceRow, value === choice.sys_id && styles.choiceSelected]}
            onPress={() => onChange(value === choice.sys_id ? '' : choice.sys_id)}
            activeOpacity={0.7}
          >
            <View style={[styles.radio, value === choice.sys_id && styles.radioSelected]} />
            <Text style={[styles.choiceLabel, value === choice.sys_id && styles.choiceLabelSelected]}>
              {choice.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  }

  if (datatype === 'boolean') {
    return (
      <View style={styles.field}>
        <Text style={styles.label}>
          {label}
          {mandatory && <Text style={styles.required}> *</Text>}
        </Text>
        {['Yes', 'No'].map((opt) => {
          const boolVal = opt === 'Yes' ? 'true' : 'false';
          return (
            <TouchableOpacity
              key={opt}
              style={[styles.choiceRow, value === boolVal && styles.choiceSelected]}
              onPress={() => onChange(value === boolVal ? '' : boolVal)}
              activeOpacity={0.7}
            >
              <View style={[styles.radio, value === boolVal && styles.radioSelected]} />
              <Text style={[styles.choiceLabel, value === boolVal && styles.choiceLabelSelected]}>
                {opt}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  }

  if (datatype === 'attachment') {
    return (
      <View style={styles.field}>
        <Text style={styles.label}>
          {label}
          {mandatory && <Text style={styles.required}> *</Text>}
        </Text>
        {Platform.OS === 'web'
          ? <WebFileInput value={value} onChange={onChange} />
          : <Text style={styles.attachmentNote}>📎 Attachment upload not supported on this platform.</Text>
        }
      </View>
    );
  }

  // string, custom, scale, numeric — text input
  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {label}
        {mandatory && <Text style={styles.required}> *</Text>}
      </Text>
      <TextInput
        ref={Platform.OS === 'web' && datatype === 'string' ? webInputRef : undefined}
        style={[styles.textInput, datatype === 'string' && { minHeight: Platform.OS === 'web' ? 80 : inputHeight }]}
        value={value || ''}
        onChangeText={onChange}
        multiline={datatype === 'string'}
        onContentSizeChange={datatype === 'string' && Platform.OS !== 'web'
          ? (e) => {
              const h = Math.max(80, e.nativeEvent.contentSize.height + 16);
              if (h !== inputHeightRef.current) {
                inputHeightRef.current = h;
                setInputHeight(h);
              }
            }
          : undefined}
        placeholder="Enter response…"
        placeholderTextColor="#9aabb8"
        keyboardType={datatype === 'numeric' || datatype === 'scale' ? 'numeric' : 'default'}
      />
    </View>
  );
}

// ─────────────────────────────────────────────
// Main screen
// ─────────────────────────────────────────────

function WebTabBar({ categories, activeCategoryIndex, onSelect, isCategoryComplete }) {
  const scrollRef = useRef(null);
  const intervalRef = useRef(null);

  function startScroll(dir) {
    if (intervalRef.current) return;
    intervalRef.current = setInterval(() => {
      if (scrollRef.current) scrollRef.current.scrollLeft += dir * 12;
    }, 16);
  }
  function stopScroll() {
    clearInterval(intervalRef.current);
    intervalRef.current = null;
  }

  return React.createElement('div', {
    onMouseMove: (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < 80) startScroll(-1);
      else if (x > rect.width - 80) startScroll(1);
      else stopScroll();
    },
    onMouseLeave: stopScroll,
    style: { backgroundColor: '#ffffff', borderBottom: '1px solid #d8dde6' },
  },
    React.createElement('div', {
      ref: scrollRef,
      style: {
        display: 'flex', overflowX: 'auto', scrollbarWidth: 'none',
        msOverflowStyle: 'none', padding: '0 8px', gap: 0,
      },
    },
      ...categories.map((cat, idx) => {
        const isActive = idx === activeCategoryIndex;
        const complete = isCategoryComplete(cat);
        return React.createElement('button', {
          key: cat.catID,
          onClick: () => onSelect(idx),
          style: {
            padding: '10px 16px', border: 'none', borderBottom: isActive ? '2px solid #0070d2' : '2px solid transparent',
            cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 12,
            fontWeight: isActive ? '600' : '400', flexShrink: 0,
            backgroundColor: 'transparent',
            color: isActive ? '#0070d2' : '#67717e',
            marginBottom: '-1px',
          },
        },
          cat.name,
          !complete && React.createElement('span', { style: { color: '#d93025', fontWeight: '700' } }, ' *')
        );
      })
    )
  );
}

export default function AssessmentPlayer({ route, navigation }) {
  const { assessmentData, instanceSysId, fromDeepLink } = route.params || {};
  const isOnline = useOnlineStatus();

  // Fall back to the in-memory store when navigating from SkuSelection (no params on web)
  const initialPayload = assessmentData?.body || assessmentData || assessmentStore.get() || null;
  const [payload, setPayload] = useState(initialPayload);
  const [loading, setLoading] = useState(!initialPayload);
  const [error, setError] = useState(null);

  const [sessionSkus, setSessionSkus] = useState([]);

  // answers: { [metricID]: string }
  const [answers, setAnswers] = useState({});

  const [activeCategoryIndex, setActiveCategoryIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [leaveVisible, setLeaveVisible] = useState(false);
  const leaveActionRef = useRef(null);
  const [uploadProgress, setUploadProgress] = useState(null); // { done, total } | null
  const categoryHydrated = useRef(false);

  // Persist answers and category index to AsyncStorage on every change
  useEffect(() => {
    if (Object.keys(answers).length === 0) return;
    assessmentStore.saveAnswers(answers).catch(e => {
      if (e?.message === 'QUOTA_EXCEEDED') {
        if (Platform.OS === 'web') {
          window.alert('Storage full — your last photo could not be saved. Submit what you have or remove some photos to continue.');
        } else {
          Alert.alert('Storage Full', 'Your last photo could not be saved. Submit what you have or remove some photos to continue.');
        }
      }
    });
  }, [answers]);

  useEffect(() => {
    if (!categoryHydrated.current) return;
    assessmentStore.saveCategoryIndex(activeCategoryIndex);
  }, [activeCategoryIndex]);

  useEffect(() => {
    assessmentStore.loadSkus().then(skus => { if (skus) setSessionSkus(skus); });
  }, []);

  // Filter SKU lines in the Audit Information description to only show selected SKUs
  useEffect(() => {
    if (!payload || sessionSkus.length === 0) return;

    const auditCat = payload.categories?.find(c => /audit info/i.test(c.name));
    if (!auditCat) return;
    const descQ = auditCat.questions?.find(q => /^description$/i.test(q.name));
    if (!descQ) return;

    const skuLabels = new Set(sessionSkus.map(s => s.label.toLowerCase()));

    setAnswers(prev => {
      const current = prev[descQ.metricID] || descQ.existing_string_value || '';
      if (!current) return prev;
      const filtered = current
        .split('\n')
        .filter(line => {
          const m = line.match(/^SKU:\s*(.+)/i);
          if (!m) return true;
          return skuLabels.has(m[1].trim().toLowerCase());
        })
        .join('\n');
      if (filtered === current) return prev;
      return { ...prev, [descQ.metricID]: filtered };
    });
  }, [sessionSkus, payload]);

  // ── Load payload from deep link ────────────────────────
  useEffect(() => {
    if (payload) {
      prefillAnswers(payload);
      setLoading(false);
      return;
    }

    if (!instanceSysId) {
      // Page was refreshed — try to restore from AsyncStorage
      assessmentStore.hydrate().then(async stored => {
        if (stored) {
          setPayload(stored);
          await prefillAnswers(stored);
        } else {
          setError('No assessment data or instance ID provided.');
        }
        setLoading(false);
      });
      return;
    }

    async function load() {
      setLoading(true);
      try {
        // Try cache first
        const cached = await getCached(instanceSysId);
        if (cached) {
          setPayload(cached);
          await prefillAnswers(cached);
        }

        // If online, always fetch fresh
        if (isOnline) {
          const fresh = await fetchAssessmentByInstance(instanceSysId);
          const body = fresh?.result?.body || fresh?.body || fresh;
          await setCached(instanceSysId, body);
          setPayload(body);
          await prefillAnswers(body);
        } else if (!cached) {
          setError('No network connection and no cached data for this assessment.');
        }
      } catch (e) {
        setError(e.message || 'Failed to load assessment.');
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [instanceSysId]);

  async function prefillAnswers(data) {
    const prefilled = {};
    (data.categories || []).forEach(cat => {
      (cat.questions || []).forEach(q => {
        if (q.existing_string_value && q.datatype === 'string') {
          prefilled[q.metricID] = q.existing_string_value;
        } else if (q.existing_value && q.existing_value !== '-1') {
          prefilled[q.metricID] = q.existing_value;
        }
      });
    });
    const [saved, savedIndex, loadedSkus] = await Promise.all([
      assessmentStore.loadAnswers(),
      assessmentStore.loadCategoryIndex(),
      assessmentStore.loadSkus(),
    ]);

    let finalAnswers = saved && Object.keys(saved).length > 0 ? { ...prefilled, ...saved } : prefilled;

    // Apply SKU filter to description immediately so saved answers can't overwrite a filtered value
    const skusForFilter = loadedSkus || [];
    if (skusForFilter.length > 0) {
      const auditCat = data.categories?.find(c => /audit info/i.test(c.name));
      if (auditCat) {
        const descQ = auditCat.questions?.find(q => /^description$/i.test(q.name));
        if (descQ && finalAnswers[descQ.metricID]) {
          const skuLabels = new Set(skusForFilter.map(s => s.label.toLowerCase()));
          finalAnswers = {
            ...finalAnswers,
            [descQ.metricID]: finalAnswers[descQ.metricID]
              .split('\n')
              .filter(line => {
                const m = line.match(/^SKU:\s*(.+)/i);
                if (!m) return true;
                return skuLabels.has(m[1].trim().toLowerCase());
              })
              .join('\n'),
          };
        }
      }
    }

    if (loadedSkus && loadedSkus.length > 0) setSessionSkus(loadedSkus);
    setAnswers(finalAnswers);
    categoryHydrated.current = true;
    if (savedIndex > 0) setActiveCategoryIndex(savedIndex);
  }

  // ── Update header branding when payload loads ─────────
  useEffect(() => {
    navigation.setOptions({
      title: '',
      headerLeft: () => (
        <Image
          source={Platform.OS === 'web' ? { uri: '/rtg-logo.png' } : require('../../assets/Rtg logo.png')}
          style={{ height: 34, width: 155, resizeMode: 'contain', marginLeft: 20 }}
        />
      ),
      headerStyle: { backgroundColor: '#1b1b38', height: 56 },
    });
  }, []);

  // ── Warn before leaving with unsaved answers ───────────
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (e.data.action.type !== 'GO_BACK' && e.data.action.type !== 'POP') return;
      e.preventDefault();
      leaveActionRef.current = e.data.action;
      setLeaveVisible(true);
    });
    return unsub;
  }, [navigation]);

  // ── Dependency resolution ──────────────────────────────
  function isVisible(question, categoryQuestions) {
    // Category gating: hide all other questions until "Yes" is explicitly selected.
    const gatingQ = categoryQuestions.find(q =>
      /(complete this category|want to complete)/i.test(q.question || q.name)
    );
    if (gatingQ && gatingQ.metricID !== question.metricID) {
      const yesChoice = (gatingQ.choices || []).find(c => /^yes$/i.test(c.label));
      if (!yesChoice || answers[gatingQ.metricID] !== yesChoice.sys_id) return false;
    }

    if (!question.depends_on) return true;

    // depends_on may store the parent's internal name OR its metricID (sys_id)
    const parent = categoryQuestions.find(
      q => q.name === question.depends_on || q.metricID === question.depends_on
    );
    if (!parent) return true;

    const parentAnswer = answers[parent.metricID];
    if (!parentAnswer) return false;

    // displayed_when holds the sys_id of the choice that triggers display
    return parentAnswer === question.displayed_when;
  }

  // ── Answer setter ──────────────────────────────────────
  const setAnswer = useCallback((metricID, value) => {
    setAnswers(prev => ({ ...prev, [metricID]: value }));
  }, []);

  // ── Category completion check ──────────────────────────
  function isCategoryComplete(cat) {
    // Category gating: "Do you want to complete this category?" answered "No" → treat as complete
    const gatingQ = (cat.questions || []).find(q =>
      /(complete this category|want to complete)/i.test(q.question || q.name)
    );
    if (gatingQ) {
      const noChoice = (gatingQ.choices || []).find(c => /^no$/i.test(c.label));
      if (noChoice && answers[gatingQ.metricID] === noChoice.sys_id) return true;
    }

    return (cat.questions || [])
      .filter(q => !/will this standard be exempted/i.test(q.question || q.name))
      .filter(q => q.mandatory)
      .filter(q => isVisible(q, cat.questions))
      .every(q => {
        const label = q.question || q.name || '';

        // SKU dimensions — every SKU must have every field filled
        if (/sku.*assembly|assembly.*dimension/i.test(label)) {
          const val = answers[q.metricID];
          if (!val) return false;
          try {
            const data = JSON.parse(val);
            const fields = isNPI ? [...SKU_DIM_BASE, ...SKU_DIM_NPI] : SKU_DIM_BASE;
            return sessionSkus.length > 0 && sessionSkus.every(sku => {
              const skuData = data[sku.sys_id] || {};
              return fields.every(f => skuData[f.key]?.toString().trim());
            });
          } catch { return false; }
        }

        const val = answers[q.metricID];
        if (Array.isArray(val)) return val.length > 0;
        return val !== undefined && val !== '' && val !== null;
      });
  }

  // ── Submit ─────────────────────────────────────────────
  function handleSubmitPress() {
    if (!isOnline) {
      if (Platform.OS === 'web') {
        window.alert('No internet connection. Please connect to Wi-Fi or mobile data before submitting. Your answers are saved and will still be here when you reconnect.');
      } else {
        Alert.alert('No Connection', 'Please connect to Wi-Fi or mobile data before submitting.\n\nYour answers are saved and will still be here when you reconnect.');
      }
      return;
    }

    if (!allComplete) {
      const incomplete = categories
        .filter(c => !isCategoryComplete(c))
        .map(c => `  • ${c.name}`)
        .join('\n');
      if (Platform.OS === 'web') {
        window.alert(`Please complete all required fields (*) in:\n\n${incomplete}`);
      } else {
        Alert.alert('Incomplete Categories', `Please complete all required fields (*) in:\n\n${incomplete}`, [{ text: 'OK' }]);
      }
      return;
    }

    if (Platform.OS === 'web') {
      if (window.confirm('Once submitted, answers cannot be changed. Are you sure?')) {
        doSubmit();
      }
    } else {
      Alert.alert(
        'Submit Assessment',
        'Once submitted, answers cannot be changed. Are you sure?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Submit', style: 'default', onPress: () => doSubmit() },
        ]
      );
    }
  }

  async function doSubmit() {
    if (!payload) return;

    const preKnownInstanceId = instanceSysId || payload.instance_sys_id;
    const metricTypeSysId = payload.sys_id;
    const submittedAt = new Date().toISOString();

    const questionMap = {};
    (payload.categories || []).forEach(cat =>
      (cat.questions || []).forEach(q => { questionMap[q.metricID] = q; })
    );

    // Collect attachment answers for separate upload after submit
    const attachmentAnswers = [];

    const submitCategories = (payload.categories || []).map(cat => ({
      catID: cat.catID,
      questions: (cat.questions || [])
        .filter(q => isVisible(q, cat.questions))
        .filter(q => {
            const v = answers[q.metricID];
            return Array.isArray(v) ? v.length > 0 : (v !== undefined && v !== '');
          })
        .map(q => {
          const raw = answers[q.metricID] || '';
          const question = questionMap[q.metricID];

          if (question?.datatype === 'choice') {
            const choice = (question.choices || []).find(c => c.sys_id === raw);
            return {
              metricID: q.metricID,
              value: choice ? choice.value : raw,
              string_value: choice ? choice.label : raw,
            };
          }

          if (question?.datatype === 'boolean') {
            const boolVal = raw === 'true' ? '1' : '0';
            return {
              metricID: q.metricID,
              value: boolVal,
              string_value: raw === 'true' ? 'Yes' : 'No',
            };
          }

          // Strip file refs from body — upload separately after submit
          if (question?.datatype === 'attachment') {
            const fileList = Array.isArray(raw) ? raw : (raw && (raw.startsWith('data:') || raw.startsWith('idb:')) ? [raw] : []);
            fileList.forEach(fileRef => attachmentAnswers.push({ metricID: q.metricID, fileRef }));
            return { metricID: q.metricID, value: '', string_value: '' };
          }

          return { metricID: q.metricID, value: raw, string_value: raw };
        }),
    }));

    const submitBody = {
      metric_type_sys_id: metricTypeSysId,
      instance_sys_id: preKnownInstanceId,
      task_sys_id: payload.task_sys_id || null,
      submitted_by: null,
      submitted_at: submittedAt,
      categories: submitCategories,
    };

    setSubmitting(true);
    try {
      const result = await submitAssessment(submitBody);

      // For fresh assessments (no pre-known instance), SN creates a new instance on submit —
      // use the returned sys_id for all subsequent calls.
      const instanceId = preKnownInstanceId || result?.body?.instance_sys_id;

      let failedPhotoCount = 0;
      if (attachmentAnswers.length > 0 && instanceId) {
        setUploadProgress({ done: 0, total: attachmentAnswers.length });
        for (let i = 0; i < attachmentAnswers.length; i++) {
          const { metricID, fileRef } = attachmentAnswers[i];
          let uploaded = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              let base64;
              if (fileRef.startsWith('idb:')) {
                const entry = await photoStore.load(fileRef);
                if (!entry?.blob) throw new Error('Photo missing from local storage');
                base64 = await blobToBase64(entry.blob);
              } else {
                base64 = fileRef; // legacy base64 format
              }
              await uploadAttachment(instanceId, metricID, base64);
              uploaded = true;
              break;
            } catch (err) {
              console.warn(`Photo ${i + 1} upload attempt ${attempt + 1} failed:`, err?.message);
              if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            }
          }
          if (!uploaded) failedPhotoCount++;
          setUploadProgress({ done: i + 1, total: attachmentAnswers.length });
        }
        setUploadProgress(null);
        if (failedPhotoCount > 0) {
          console.error(`${failedPhotoCount} of ${attachmentAnswers.length} photo(s) failed to upload after 3 attempts.`);
        }
      }

      if (instanceId) {
        const instanceNumber = result?.body?.instance_number || instanceId;
        await assessmentStore.savePendingComplete({ instanceId, submittedAt, instanceNumber });
        await completeAssessment(instanceId);
        await assessmentStore.clearPendingComplete();
      }

      await assessmentStore.clear();
      await photoStore.clear();
      navigation.replace('SubmissionSuccess', {
        instanceNumber:   result?.body?.instance_number || instanceId,
        answered:         result?.body?.answered ?? null,
        skipped:          result?.body?.skipped   ?? null,
        submittedAt,
        failedPhotoCount: failedPhotoCount > 0 ? failedPhotoCount : undefined,
        totalPhotos:      attachmentAnswers.length > 0 ? attachmentAnswers.length : undefined,
      });
    } catch (e) {
      const msg = e.message || '';
      const isNetworkError = msg === 'Failed to fetch' || msg.includes('ERR_INTERNET_DISCONNECTED') || msg.includes('Network request failed') || msg.includes('Load failed');

      const isCompleteFailure = msg.toLowerCase().includes('complete');
      if (isCompleteFailure) {
        // Answers are in SN — pending complete is already saved and will retry on next open
        await assessmentStore.clear();
        await photoStore.clear();
        navigation.replace('SubmissionSuccess', {
          instanceNumber: null,
          answered: null,
          skipped: null,
          submittedAt,
        });
        return;
      }

      const userMsg = isNetworkError
        ? 'Unable to reach the server. Please check your connection and try again.\n\nYour answers are still saved.'
        : `Submission failed: ${msg || 'Please try again.'}`;
      if (Platform.OS === 'web') {
        window.alert(userMsg);
      } else {
        Alert.alert('Submission Failed', userMsg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render states ──────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0a2540" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.retryBtnText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!payload) return null;

  const categories = payload.categories || [];
  const activeCategory = categories[activeCategoryIndex];
  const isNPI = !!(payload.isNPI || /^npi/i.test(payload.title || ''));
  const allComplete = categories.every(isCategoryComplete);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* ── Page title band ── */}
      <View style={styles.pageTitleBand}>
        <Text style={styles.pageTitleText} numberOfLines={1}>{payload?.title || 'Assessment'}</Text>
      </View>

      {/* ── Offline banner ── */}
      {!isOnline && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>⚡ Offline — answers are saved. Reconnect to submit.</Text>
        </View>
      )}

      {/* ── Category tabs ── */}
      <WebTabBar
        categories={categories}
        activeCategoryIndex={activeCategoryIndex}
        onSelect={setActiveCategoryIndex}
        isCategoryComplete={isCategoryComplete}
      />

      {/* ── Questions ── */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {activeCategory && (
          <>
            <Text style={styles.categoryTitle}>{activeCategory.name}</Text>
            {(activeCategory.questions || [])
              .filter(q => !/will this standard be exempted/i.test(q.question || q.name))
              .filter(q => isVisible(q, activeCategory.questions))
              .sort((a, b) => Number(a.order) - Number(b.order))
              .map(q => (
                <QuestionField
                  key={q.metricID}
                  question={q}
                  value={answers[q.metricID] || ''}
                  onChange={(val) => setAnswer(q.metricID, val)}
                  sessionSkus={sessionSkus}
                  isNPI={isNPI}
                />
              ))}
          </>
        )}

        {/* ── Navigation between categories ── */}
        <View style={styles.navRow}>
          {activeCategoryIndex > 0 && (
            <TouchableOpacity
              style={styles.navBtn}
              onPress={() => setActiveCategoryIndex(i => i - 1)}
            >
              <Text style={styles.navBtnText}>← Previous</Text>
            </TouchableOpacity>
          )}
          {activeCategoryIndex < categories.length - 1 ? (
            <TouchableOpacity
              style={[styles.navBtn, styles.navBtnPrimary]}
              onPress={() => setActiveCategoryIndex(i => i + 1)}
            >
              <Text style={[styles.navBtnText, styles.navBtnTextPrimary]}>Next →</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.navBtn, styles.submitBtn, submitting && styles.submitBtnDisabled]}
              onPress={handleSubmitPress}
              disabled={submitting}
            >
              {submitting
                ? uploadProgress
                  ? <Text style={styles.submitBtnText}>
                      Uploading… {Math.round(uploadProgress.done / uploadProgress.total * 100)}%
                    </Text>
                  : <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.submitBtnText}>
                    {allComplete ? 'Submit Assessment' : 'Submit Assessment (*)'}
                  </Text>
              }
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>

      {/* ── Leave confirmation modal ── */}
      {leaveVisible && (
        <View style={styles.overlay}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Leave Assessment?</Text>
            <Text style={styles.dialogMsg}>
              Your answers are saved. You can return to this assessment from the home screen.
            </Text>
            <View style={styles.dialogBtns}>
              <TouchableOpacity style={styles.dialogCancel} onPress={() => setLeaveVisible(false)}>
                <Text style={styles.dialogCancelText}>Stay</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.dialogLeave} onPress={() => { setLeaveVisible(false); navigation.dispatch(leaveActionRef.current); }}>
                <Text style={styles.dialogLeaveText}>Leave</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#f5f7fa',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 15,
    color: '#5a7a8a',
  },
  errorText: {
    fontSize: 15,
    color: '#c0392b',
    textAlign: 'center',
    marginBottom: 16,
  },
  retryBtn: {
    backgroundColor: '#0070d2',
    borderRadius: 4,
    paddingVertical: 10,
    paddingHorizontal: 24,
  },
  retryBtnText: {
    color: '#fff',
    fontWeight: '600',
  },
  pageTitleBand: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#d8dde6',
  },
  pageTitleText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1b1b38',
  },
  offlineBanner: {
    backgroundColor: '#fff3cd',
    paddingVertical: 6,
    paddingHorizontal: 16,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#ffc107',
  },
  offlineBannerText: {
    color: '#856404',
    fontSize: 12,
    fontWeight: '600',
  },
  tabBar: {
    backgroundColor: '#ffffff',
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: '#d8dde6',
  },
  tab: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#0070d2',
  },
  tabText: {
    color: '#67717e',
    fontSize: 12,
    fontWeight: '400',
  },
  tabTextActive: {
    color: '#0070d2',
    fontWeight: '600',
  },
  scroll: {
    flex: 1,
    backgroundColor: '#f2f4f7',
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  categoryTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1b1b38',
    marginBottom: 16,
  },
  field: {
    backgroundColor: '#ffffff',
    borderRadius: 4,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#d8dde6',
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1b1b38',
    marginBottom: 10,
    lineHeight: 20,
  },
  required: {
    color: '#d93025',
  },
  choiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 4,
    marginBottom: 4,
    backgroundColor: '#f8f9fb',
    borderWidth: 1,
    borderColor: '#d8dde6',
  },
  choiceSelected: {
    backgroundColor: '#e8f0fe',
    borderColor: '#0070d2',
  },
  radio: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#8a94a0',
    marginRight: 10,
  },
  radioSelected: {
    borderColor: '#0070d2',
    backgroundColor: '#0070d2',
  },
  choiceLabel: {
    fontSize: 13,
    color: '#1b1b38',
    flex: 1,
  },
  choiceLabelSelected: {
    color: '#0070d2',
    fontWeight: '600',
  },
  textInput: {
    borderWidth: 1,
    borderColor: '#d8dde6',
    borderRadius: 4,
    padding: 10,
    fontSize: 13,
    color: '#1b1b38',
    backgroundColor: '#ffffff',
    textAlignVertical: 'top',
  },
  attachmentNote: {
    fontSize: 13,
    color: '#67717e',
    fontStyle: 'italic',
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 3,
    borderWidth: 2,
    borderColor: '#8a94a0',
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: {
    borderColor: '#0070d2',
    backgroundColor: '#0070d2',
  },
  checkmark: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 14,
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
    gap: 10,
  },
  navBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#d8dde6',
    alignItems: 'center',
    backgroundColor: '#ffffff',
  },
  navBtnPrimary: {
    backgroundColor: '#0070d2',
    borderColor: '#0070d2',
  },
  navBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1b1b38',
  },
  navBtnTextPrimary: {
    color: '#ffffff',
  },
  submitBtn: {
    flex: 1,
    backgroundColor: '#0070d2',
    borderColor: '#0070d2',
  },
  submitBtnDisabled: {
    backgroundColor: '#8a94a0',
    borderColor: '#8a94a0',
    opacity: 0.7,
  },
  submitBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  tabIncomplete: {
    color: '#d93025',
    fontWeight: '700',
  },
  skuAccordion: {
    borderWidth: 1, borderColor: '#d8dde6', borderRadius: 4,
    marginBottom: 8, overflow: 'hidden',
  },
  skuAccordionHeader: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#f2f4f7', paddingVertical: 10, paddingHorizontal: 12,
  },
  skuAccordionTitle: {
    flex: 1, fontSize: 13, fontWeight: '600', color: '#1b1b38',
  },
  skuBadge: {
    backgroundColor: '#8a94a0', borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  skuBadgeDone: { backgroundColor: '#3ba755' },
  skuBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  skuAccordionBody: {
    padding: 12, backgroundColor: '#fff',
  },
  skuFieldLabel: {
    fontSize: 12, fontWeight: '600', color: '#1b1b38', marginBottom: 4,
  },
  skuFieldHint: {
    fontWeight: '400', color: '#67717e',
  },

  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center',
    zIndex: 100,
  },
  dialog: {
    backgroundColor: '#fff', borderRadius: 4, padding: 24,
    width: '85%', maxWidth: 400,
    borderWidth: 1, borderColor: '#d8dde6',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 8, elevation: 8,
  },
  dialogTitle:      { fontSize: 16, fontWeight: '700', color: '#1b1b38', marginBottom: 10 },
  dialogMsg:        { fontSize: 13, color: '#67717e', lineHeight: 20, marginBottom: 24 },
  dialogBtns:       { flexDirection: 'row', gap: 10 },
  dialogCancel:     { flex: 1, borderWidth: 1, borderColor: '#d8dde6', borderRadius: 4, paddingVertical: 11, alignItems: 'center' },
  dialogCancelText: { color: '#67717e', fontWeight: '600', fontSize: 13 },
  dialogLeave:      { flex: 1, backgroundColor: '#d93025', borderRadius: 4, paddingVertical: 11, alignItems: 'center' },
  dialogLeaveText:  { color: '#fff', fontWeight: '700', fontSize: 13 },
});