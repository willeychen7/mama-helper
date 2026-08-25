import React, { useState, useRef, useEffect } from 'react';
import {
  Camera,
  Volume2,
  AlertTriangle,
  CheckCircle,
  ShieldAlert,
  RefreshCw,
  ShieldCheck,
  X,
  HelpCircle,
  SwitchCamera
} from 'lucide-react';
import heic2any from 'heic2any';
import './App.css';

const API_BASE_URL = 'http://127.0.0.1:8000';

export default function App() {
  // ==========================================
  // 核心状态
  // ==========================================

  const [imagePreview, setImagePreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('');

  const [isScanning, setIsScanning] = useState(false);
  const [showAnalysisResults, setShowAnalysisResults] = useState(false);

  const [showCancelModal, setShowCancelModal] = useState(false);

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // ==========================================
  // 摄像头
  // ==========================================

  const [isCameraActive, setIsCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState('environment');

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const abortControllerRef = useRef(null);

  // 保存当前 Object URL，方便之后释放
  const imagePreviewUrlRef = useRef(null);

  // ==========================================
  // 清理 Object URL
  // ==========================================

  const revokePreviewUrl = () => {
    if (imagePreviewUrlRef.current) {
      URL.revokeObjectURL(imagePreviewUrlRef.current);
      imagePreviewUrlRef.current = null;
    }
  };

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      revokePreviewUrl();
      stopCamera();

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // ==========================================
  // 重置 / 关闭
  // ==========================================

  const handleClose = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    revokePreviewUrl();

    setImagePreview(null);
    setResult(null);
    setError(null);
    setLoading(false);
    setLoadingText('');
    setIsScanning(false);
    setShowAnalysisResults(false);
    setShowCancelModal(false);

    stopCamera();
  };

  const handleRequestClose = () => {
    if (loading || isScanning) {
      setShowCancelModal(true);
    } else {
      handleClose();
    }
  };

  const handleConfirmCancel = () => {
    handleClose();
  };

  const handleResumeScan = () => {
    setShowCancelModal(false);
  };

  // ==========================================
  // 摄像头控制
  // ==========================================

  const startCamera = async (targetMode = facingMode) => {
    setError(null);

    stopCamera();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError('您的浏览器暂时无法打开摄像头，请使用手机相册选择照片。');
      return;
    }

    try {
      const stream = await navigator.mediaDevices
        .getUserMedia({
          video: {
            facingMode: { exact: targetMode }
          },
          audio: false
        })
        .catch(async () => {
          return await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: targetMode
            },
            audio: false
          });
        });

      streamRef.current = stream;

      setFacingMode(targetMode);
      setIsCameraActive(true);

      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      }, 100);

    } catch (err) {
      console.error('Camera access failed:', err);

      setError(
        '无法打开摄像头。请检查浏览器的摄像头权限，或者直接从手机相册选择照片。'
      );
    }
  };

  const toggleCameraFacing = () => {
    const nextMode =
      facingMode === 'environment' ? 'user' : 'environment';

    startCamera(nextMode);
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        track.stop();
      });

      streamRef.current = null;
    }

    setIsCameraActive(false);
  };

  // ==========================================
  // 拍照
  // ==========================================

  const capturePhoto = () => {
    if (!videoRef.current) {
      setError('没有找到摄像头画面，请重新打开摄像头。');
      return;
    }

    const video = videoRef.current;

    const canvas = document.createElement('canvas');

    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;

    const ctx = canvas.getContext('2d');

    if (!ctx) {
      setError('拍照失败，请重新尝试。');
      return;
    }

    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    ctx.drawImage(
      video,
      0,
      0,
      canvas.width,
      canvas.height
    );

    stopCamera();

    canvas.toBlob(
      async (blob) => {
        if (blob) {
          const file = new File(
            [blob],
            'captured_letter.jpg',
            {
              type: 'image/jpeg'
            }
          );

          await handleProcessFile(file);
        } else {
          setError('拍照失败，请重新拍一张。');
        }
      },
      'image/jpeg',
      0.9
    );
  };

  // ==========================================
  // 计算距离截止日期还有几天
  // ==========================================

  const getDaysLeft = (dueDateStr) => {
    if (!dueDateStr) return null;

    const targetDate = new Date(dueDateStr);

    if (isNaN(targetDate.getTime())) {
      return null;
    }

    const today = new Date();

    today.setHours(0, 0, 0, 0);
    targetDate.setHours(0, 0, 0, 0);

    const diffTime = targetDate - today;

    const diffDays = Math.ceil(
      diffTime / (1000 * 60 * 60 * 24)
    );

    return diffDays;
  };

  // ==========================================
  // 图片预处理
  // ==========================================

  const processImagePrivacy = async (file) => {
    return new Promise(async (resolve, reject) => {
      try {
        setLoadingText('正在处理照片，请稍候...');

        let imageFile = file;

        // HEIC → JPEG
        if (
          file.type === 'image/heic' ||
          file.name.toLowerCase().endsWith('.heic')
        ) {
          const convertedBlob = await heic2any({
            blob: file,
            toType: 'image/jpeg',
            quality: 0.8
          });

          imageFile = Array.isArray(convertedBlob)
            ? convertedBlob[0]
            : convertedBlob;
        }

        const img = new Image();

        const reader = new FileReader();

        reader.onload = (e) => {
          img.src = e.target.result;
        };

        reader.onerror = () => {
          reject(
            new Error('照片读取失败，请重新选择照片。')
          );
        };

        img.onerror = () => {
          reject(
            new Error('图片格式不受支持或文件损坏。')
          );
        };

        img.onload = () => {
          const canvas = document.createElement('canvas');

          // 控制上传图片大小
          const maxDimension = 1280;

          let width = img.width;
          let height = img.height;

          if (
            width > maxDimension ||
            height > maxDimension
          ) {
            if (width > height) {
              height = Math.round(
                (height * maxDimension) / width
              );

              width = maxDimension;
            } else {
              width = Math.round(
                (width * maxDimension) / height
              );

              height = maxDimension;
            }
          }

          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');

          if (!ctx) {
            reject(
              new Error('照片处理失败，请重新尝试。')
            );
            return;
          }

          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';

          ctx.drawImage(
            img,
            0,
            0,
            width,
            height
          );

          canvas.toBlob(
            (blob) => {
              if (blob) {
                // 释放之前的 preview URL
                revokePreviewUrl();

                const previewUrl =
                  URL.createObjectURL(blob);

                imagePreviewUrlRef.current =
                  previewUrl;

                setImagePreview(previewUrl);

                resolve({
                  blob,
                  previewUrl
                });
              } else {
                reject(
                  new Error(
                    '照片处理失败，请重新尝试。'
                  )
                );
              }
            },
            'image/jpeg',
            0.85
          );
        };

        reader.readAsDataURL(imageFile);

      } catch (err) {
        reject(
          new Error(
            '照片处理失败，请重新拍一张。'
          )
        );
      }
    });
  };

  // ==========================================
  // 文件处理
  // ==========================================

  const handleProcessFile = async (file) => {
    setResult(null);
    setError(null);

    revokePreviewUrl();

    setImagePreview(null);
    setShowAnalysisResults(false);

    setLoading(true);

    try {
      const { blob } =
        await processImagePrivacy(file);

      setLoading(false);

      setIsScanning(true);

      await analyzeLetter(blob);

    } catch (err) {
      console.error(
        'Image processing failed:',
        err
      );

      if (err.name === 'AbortError') {
        console.log(
          '用户取消了图片处理'
        );

        return;
      }

      setError(
        '照片处理失败，请重新拍一张。'
      );

      setLoading(false);
      setIsScanning(false);
    }
  };

  // ==========================================
  // 从相册选择
  // ==========================================

  const handleImageUpload = (e) => {
    const file =
      e.target.files &&
      e.target.files[0];

    if (file) {
      handleProcessFile(file);
    }

    // 允许用户再次选择同一张照片
    e.target.value = null;
  };

  // ==========================================
  // AI 分析信件
  // ==========================================

  const analyzeLetter = async (imageBlob) => {
    abortControllerRef.current =
      new AbortController();

    let isTimeout = false;

    const timeoutId = setTimeout(() => {
      isTimeout = true;

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    }, 30000);

    const formData = new FormData();

    formData.append(
      'file',
      imageBlob,
      'letter.jpg'
    );

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/analyze-letter`,
        {
          method: 'POST',
          body: formData,
          signal:
            abortControllerRef.current.signal
        }
      );

      if (!response.ok) {
        const errorText =
          await response.text();

        throw new Error(
          `服务解析失败 (${response.status}): ${
            errorText || '请检查后端接口'
          }`
        );
      }

      const resData =
        await response.json();

      if (
        !resData ||
        !resData.data
      ) {
        throw new Error(
          '服务返回数据格式不完整'
        );
      }

      setResult(resData.data);

      setShowAnalysisResults(true);

    } catch (err) {
      // ==========================================
      // 开发者 Console 保留技术错误
      // 老人只看到简单中文
      // ==========================================

      console.error(
        'Letter analysis failed:',
        err
      );

      if (err.name === 'AbortError') {
        if (isTimeout) {
          console.error(
            'Letter analysis timeout after 30 seconds.'
          );

          setError(
            '识别时间有点久，请稍后重新拍一张。'
          );

          setShowAnalysisResults(true);

        } else {
          console.log(
            'Letter analysis was cancelled by user.'
          );
        }

        return;
      }

      setError(
        '暂时没有识别成功，请重新拍一张。'
      );

      setShowAnalysisResults(true);

    } finally {
      clearTimeout(timeoutId);

      setIsScanning(false);

      abortControllerRef.current = null;
    }
  };

  // ==========================================
  // 语音朗读
  // ==========================================

  const handleSpeak = (text) => {
    if (!text) return;

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();

      const utterance =
        new SpeechSynthesisUtterance(text);

      utterance.lang = 'zh-CN';

      utterance.rate = 0.85;

      window.speechSynthesis.speak(
        utterance
      );

    } else {
      alert(
        '您的浏览器暂不支持语音功能。'
      );
    }
  };

  // ==========================================
  // 页面
  // ==========================================

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 p-4 md:p-8 font-sans relative">

      {/* ==========================================
          Header
      ========================================== */}

      <header className="max-w-xl mx-auto text-center my-6">

        <div className="flex items-center justify-center space-x-2 mb-2">

          <ShieldCheck
            className="text-green-600"
            size={36}
          />

          <h1 className="text-4xl font-extrabold text-blue-800 tracking-wide">
            安心小助手
          </h1>

        </div>

        <p className="text-xl text-slate-600 font-medium">
          拍照识信，中文解读
        </p>

      </header>

      <main className="max-w-xl mx-auto bg-white rounded-3xl shadow-xl p-6 border-4 border-slate-200 relative overflow-hidden">

        {/* ==========================================
            1. 实时拍照界面
        ========================================== */}

        {isCameraActive && (

          <div className="relative bg-black rounded-3xl overflow-hidden flex flex-col items-center p-2 mb-4 z-20">

            <button
              onClick={stopCamera}
              className="absolute top-4 right-4 bg-slate-900/80 hover:bg-slate-900 text-white p-2.5 rounded-full z-30 flex items-center justify-center shadow-lg border border-white/20 active:scale-95 transition-all"
              title="关闭相机"
            >
              <X size={24} />
            </button>

            <video
              ref={videoRef}
              autoPlay
              playsInline
              className={`w-full h-80 object-cover rounded-2xl ${
                facingMode === 'user'
                  ? '-scale-x-100'
                  : ''
              }`}
            />

            <div className="w-full text-center py-2 bg-slate-900/90 text-amber-300 font-bold text-base md:text-lg flex items-center justify-center space-x-1">
              <span>
                请把整封信放进画面里
              </span>
            </div>

            <div className="flex items-center justify-center gap-6 w-full my-4 px-3">

              <button
                onClick={capturePhoto}
                className="bg-red-600 hover:bg-red-700 text-white font-bold text-xl py-3 px-8 rounded-full shadow-2xl flex items-center space-x-2 border-4 border-white animate-pulse shrink-0 active:scale-95 transition-all"
              >
                <Camera size={26} />
                <span>拍照</span>
              </button>

              <button
                onClick={toggleCameraFacing}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-3 rounded-2xl flex items-center space-x-1.5 text-base font-bold shadow-md shrink-0 active:scale-95 transition-all"
              >
                <SwitchCamera size={20} />
                <span>翻转</span>
              </button>

            </div>

          </div>
        )}

        {/* ==========================================
            2. 图片处理 Loading
        ========================================== */}

        {loading && (

          <div className="text-center py-12 flex flex-col items-center justify-center space-y-6">

            <RefreshCw
              size={64}
              className="animate-spin text-blue-600 mx-auto"
            />

            <div className="bg-blue-50 border-2 border-blue-200 p-6 rounded-2xl w-full">

              <p className="text-2xl font-bold text-blue-950">
                {loadingText}
              </p>

            </div>

            <button
              onClick={handleRequestClose}
              className="bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold px-6 py-2 rounded-full text-lg"
            >
              取消处理
            </button>

          </div>
        )}

        {/* ==========================================
            3. 图片展示 + AI 扫描
        ========================================== */}

        {imagePreview &&
          !loading && (

            <div className="space-y-6">

              <div className="relative rounded-2xl overflow-hidden border-2 border-slate-300 bg-transparent shadow-inner">

                <button
                  onClick={handleRequestClose}
                  className="absolute top-3 right-3 bg-slate-900/80 hover:bg-slate-900 text-white font-bold p-2.5 rounded-full z-40 flex items-center justify-center shadow-lg border border-white/20"
                  title="关闭并返回"
                >
                  <X size={24} />
                </button>

                <div className="relative w-full block">

                  <img
                    src={imagePreview}
                    alt="信件预览"
                    className="w-full h-auto block relative z-10"
                  />

                  {isScanning && (
                    <div className="scanning-overlay z-15">
                      <div className="scanning-line"></div>
                    </div>
                  )}

                </div>

              </div>

              {/* ==========================================
                  AI 分析 Loading
              ========================================== */}

              {isScanning && (

                <div className="bg-blue-50 border-4 border-blue-400 p-6 rounded-2xl text-center space-y-3">

                  <div className="flex items-center justify-center space-x-2 text-blue-800">

                    <RefreshCw
                      size={36}
                      className="text-blue-600"
                    />

                    <span className="text-2xl font-black">
                      正在看信件...
                    </span>

                  </div>

                  <p className="text-xl text-blue-900 font-bold">
                    大概需要{' '}
                    <span className="text-red-600 text-2xl font-black">
                      3～5 秒
                    </span>
                    ，请稍等一下
                  </p>

                </div>
              )}

              {/* ==========================================
                  4. 分析结果
              ========================================== */}

              {result &&
                showAnalysisResults && (

                  <div>

                    {/* ==========================================
                        图片不可读
                    ========================================== */}

                    {result.is_readable === false ? (

                      <div className="bg-amber-50 border-4 border-amber-400 p-6 rounded-2xl text-center space-y-4 shadow-lg">

                        <AlertTriangle
                          size={56}
                          className="text-amber-600 mx-auto animate-bounce"
                        />

                        <h3 className="text-2xl font-black text-amber-950">
                          照片有些看不清
                        </h3>

                        <div className="bg-white p-4 rounded-xl border-2 border-amber-200 text-left">

                          <p className="text-lg font-bold text-amber-900 mb-1">
                            建议您这样重拍：
                          </p>

                          <p className="text-xl font-extrabold text-slate-800 leading-snug">
                            {result.unclear_reason_cn ||
                              '请将信件平放，在光线明亮的地方重新拍一张。'}
                          </p>

                        </div>

                        <div className="pt-2 flex gap-4">

                          <button
                            onClick={handleClose}
                            className="flex-1 bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-xl py-4 rounded-2xl flex items-center justify-center space-x-2"
                          >
                            <X size={24} />
                            <span>关闭</span>
                          </button>

                          <button
                            onClick={() =>
                              startCamera('environment')
                            }
                            className="flex-1 bg-amber-600 hover:bg-amber-700 text-white font-bold text-xl py-4 rounded-2xl flex items-center justify-center space-x-2 shadow-md"
                          >
                            <Camera size={24} />
                            <span>重新拍照</span>
                          </button>

                        </div>

                      </div>

                    ) : (

                      /* ==========================================
                          正常识别结果
                      ========================================== */

                      <div
                        className={`p-6 rounded-2xl border-4 ${
                          result.is_action_required
                            ? 'bg-amber-50 border-amber-400 text-amber-950'
                            : 'bg-green-50 border-green-400 text-green-950'
                        }`}
                      >

                        {/* ==========================================
                            状态 + 语音
                        ========================================== */}

                        <div className="flex items-center justify-between border-b pb-4 mb-4 border-slate-300 gap-2">

                          <div className="flex items-center space-x-3">

                            {result.is_action_required ? (
                              <AlertTriangle
                                size={40}
                                className="text-amber-600 shrink-0"
                              />
                            ) : (
                              <CheckCircle
                                size={40}
                                className="text-green-600 shrink-0"
                              />
                            )}

                            <span className="text-2xl font-black">
                              {result.is_action_required
                                ? '需要处理'
                                : '暂时不用处理'}
                            </span>

                          </div>

                          <button
                            onClick={() =>
                              handleSpeak(
                                `${result.summary_cn || ''}。建议：${
                                  result.action_cn || ''
                                }`
                              )
                            }
                            className="flex items-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-3 rounded-2xl shadow-md text-lg font-bold shrink-0"
                          >
                            <Volume2 size={28} />
                            <span>念给我听</span>
                          </button>

                        </div>

                        {/* ==========================================
                            核心信息
                        ========================================== */}

                        <div className="grid grid-cols-2 gap-4 my-4 bg-white/80 p-4 rounded-xl shadow-inner">

                          <div>

                            <p className="text-base text-slate-500 font-bold">
                              发信人
                            </p>

                            <p className="text-xl font-black text-slate-800">
                              {result.sender ||
                                '未列明'}
                            </p>

                          </div>

                          <div>

                            <p className="text-base text-slate-500 font-bold">
                              发信时间
                            </p>

                            <p className="text-xl font-black text-slate-800">
                              {result.mail_date ||
                                '未列明'}
                            </p>

                          </div>

                          <div>

                            <p className="text-base text-slate-500 font-bold">
                              需付金额
                            </p>

                            {result.amount !==
                              undefined &&
                            result.amount !== null ? (

                              <p className="text-3xl font-black text-red-600">
                                ${result.amount}
                              </p>

                            ) : (

                              <p className="text-xl font-bold text-slate-400">
                                无需支付 / 未列明
                              </p>

                            )}

                          </div>

                          <div>

                            <p className="text-base text-slate-500 font-bold">
                              截止日期
                            </p>

                            {result.due_date ? (

                              <div className="flex flex-wrap items-baseline gap-1.5">

                                <p className="text-2xl font-black text-red-600">
                                  {result.due_date}
                                </p>

                                {(() => {

                                  const days =
                                    getDaysLeft(
                                      result.due_date
                                    );

                                  if (
                                    days === null
                                  ) {
                                    return null;
                                  }

                                  if (days > 0) {

                                    return (
                                      <span className="text-xs font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded-full whitespace-nowrap">
                                        还有 {days} 天
                                      </span>
                                    );

                                  } else if (
                                    days === 0
                                  ) {

                                    return (
                                      <span className="text-xs font-bold text-white bg-red-600 px-2 py-0.5 rounded-full whitespace-nowrap animate-pulse">
                                        今天截止！
                                      </span>
                                    );

                                  } else {

                                    return (
                                      <span className="text-xs font-bold text-white bg-slate-700 px-2 py-0.5 rounded-full whitespace-nowrap">
                                        已超期{' '}
                                        {Math.abs(
                                          days
                                        )}{' '}
                                        天
                                      </span>
                                    );
                                  }

                                })()}

                              </div>

                            ) : (

                              <p className="text-xl font-bold text-slate-400">
                                未列明
                              </p>

                            )}

                          </div>

                        </div>

                        {/* ==========================================
                            信件大意
                        ========================================== */}

                        <div className="space-y-3 text-xl font-medium leading-relaxed">

                          <div>

                            <span className="font-bold text-slate-600 block text-base">
                              信件大意
                            </span>

                            <p className="text-slate-900 font-semibold">
                              {result.summary_cn ||
                                '暂无概述'}
                            </p>

                          </div>

                          {/* ==========================================
                              第一行动
                          ========================================== */}

                          <div className="bg-white p-4 rounded-xl border-2 border-blue-200 shadow-sm">

                            <span className="font-bold text-blue-800 block text-lg mb-1">
                              第一件事：
                            </span>

                            <p className="text-blue-950 font-bold text-2xl">
                              {result.action_cn ||
                                '暂无行动建议'}
                            </p>

                          </div>

                          {/* ==========================================
                              风险提示
                          ========================================== */}

                          {result.risk_reason_cn && (

                            <div className="bg-amber-50 p-4 rounded-xl border-2 border-amber-200">

                              <span className="font-bold text-amber-800 block text-lg mb-1">
                                如果不处理：
                              </span>

                              <p className="text-amber-950 font-semibold">
                                {result.risk_reason_cn}
                              </p>

                            </div>

                          )}

                        </div>

                        {/* ==========================================
                            法律免责声明
                        ========================================== */}

                        {result.legal_disclaimer && (

                          <div className="mt-4 bg-red-50 border-2 border-red-300 p-4 rounded-2xl flex items-start space-x-3">

                            <ShieldAlert
                              size={36}
                              className="text-red-600 shrink-0 mt-1"
                            />

                            <p className="text-base text-red-900 font-medium leading-snug">

                              <strong>
                                提示：
                              </strong>{' '}
                              此信件可能涉及法律或法院文件，AI 仅提供中文辅助说明，不构成法律建议，请咨询专业人士。

                            </p>

                          </div>

                        )}

                        {/* ==========================================
                            底部按钮
                        ========================================== */}

                        <div className="mt-6 flex gap-4">

                          <button
                            onClick={handleClose}
                            className="flex-1 bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-xl py-4 rounded-2xl flex items-center justify-center space-x-2"
                          >
                            <X size={24} />
                            <span>关闭</span>
                          </button>

                          <button
                            onClick={() =>
                              startCamera(
                                'environment'
                              )
                            }
                            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xl py-4 rounded-2xl flex items-center justify-center space-x-2 shadow-md"
                          >
                            <Camera size={24} />
                            <span>再照一张</span>
                          </button>

                        </div>

                      </div>

                    )}

                  </div>

                )}

            </div>

          )}

        {/* ==========================================
            5. 首页入口
        ========================================== */}

        {!imagePreview &&
          !loading &&
          !isCameraActive && (

            <div className="my-8 space-y-4">

              <button
                onClick={() =>
                  startCamera('environment')
                }
                className="w-full h-48 bg-blue-600 hover:bg-blue-700 text-white rounded-3xl shadow-xl border-4 border-blue-400 flex flex-col items-center justify-center transition-transform active:scale-95"
              >

                <Camera
                  size={72}
                  className="mb-2"
                />

                <span className="text-3xl font-extrabold tracking-wider">
                  点击拍照
                </span>

                <span className="text-lg text-blue-100 mt-1">
                  对准信件，拍一下就知道
                </span>

              </button>

              <label className="cursor-pointer block text-center p-4 bg-slate-100 border-2 border-dashed border-slate-300 rounded-2xl hover:bg-slate-200 transition-all">

                <span className="text-lg font-bold text-slate-700">
                  从手机选择照片
                </span>

                <input
                  type="file"
                  accept="image/jpeg,image/png,image/heic,image/*"
                  className="hidden"
                  onChange={handleImageUpload}
                />

              </label>

            </div>

          )}

        {/* ==========================================
            6. 错误提示
        ========================================== */}

        {error &&
          !loading && (

            <div className="bg-red-100 border-2 border-red-400 rounded-2xl p-6 my-4 z-50 relative">

              <AlertTriangle
                size={48}
                className="text-red-600 mx-auto mb-2"
              />

              <p className="text-2xl font-bold text-red-800 text-center">
                {error}
              </p>

              <div className="flex justify-center gap-4 mt-4">

                <button
                  onClick={handleClose}
                  className="bg-slate-200 text-slate-800 text-xl font-bold py-3 px-6 rounded-full shadow hover:bg-slate-300"
                >
                  关闭
                </button>

                <button
                  onClick={() =>
                    startCamera('environment')
                  }
                  className="bg-red-600 text-white text-xl font-bold py-3 px-8 rounded-full shadow-lg hover:bg-red-700"
                >
                  重新拍照
                </button>

              </div>

            </div>

          )}

      </main>

      {/* ==========================================
          7. 取消确认弹窗
      ========================================== */}

      {showCancelModal && (

        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">

          <div className="bg-white rounded-3xl p-6 md:p-8 max-w-sm w-full text-center space-y-6 shadow-2xl border-4 border-slate-200 animate-in fade-in zoom-in duration-200">

            <HelpCircle
              size={64}
              className="text-blue-600 mx-auto animate-bounce"
            />

            <div className="space-y-2">

              <h3 className="text-2xl font-black text-slate-900">
                取消识别？
              </h3>

            </div>

            <div className="flex flex-col gap-3">

              <button
                onClick={handleConfirmCancel}
                className="w-full bg-red-600 hover:bg-red-700 text-white font-extrabold text-xl py-4 rounded-2xl shadow-lg border-2 border-red-500 active:scale-95 transition-all"
              >
                取消
              </button>

              <button
                onClick={handleResumeScan}
                className="w-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xl py-3 rounded-2xl border-2 border-slate-300 active:scale-95 transition-all"
              >
                继续
              </button>

            </div>

          </div>

        </div>

      )}

    </div>
  );
}