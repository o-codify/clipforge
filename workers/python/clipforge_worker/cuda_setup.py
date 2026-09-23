"""Подключение CUDA-библиотек из пакетов nvidia-*.

CTranslate2 под Windows не везёт с собой cuBLAS и cuDNN, а ставятся они
пакетами `nvidia-cublas-cu12` и `nvidia-cudnn-cu12` внутрь site-packages.
Python при этом их не находит: начиная с 3.8 Windows ищет зависимые DLL
только в каталогах, явно зарегистрированных через os.add_dll_directory,
а не по PATH.

Без этого вызова падает так:

    RuntimeError: Library cublas64_12.dll is not found or cannot be loaded

Импортируй этот модуль ДО faster_whisper / ctranslate2.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_done = False


def enable_cuda_dlls() -> list[Path]:
    """Зарегистрировать каталоги с CUDA DLL. Возвращает найденные пути."""
    global _done
    if _done or sys.platform != "win32":
        return []

    site_packages = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    registered: list[Path] = []

    if site_packages.is_dir():
        # Раскладка пакетов: nvidia/<компонент>/bin/*.dll
        for bin_dir in sorted(site_packages.glob("*/bin")):
            if any(bin_dir.glob("*.dll")):
                registered.append(bin_dir)
                try:
                    os.add_dll_directory(str(bin_dir))
                except OSError:
                    pass

    if registered:
        # add_dll_directory одного недостаточно. Он влияет только на загрузку
        # с флагом LOAD_LIBRARY_SEARCH_USER_DIRS, а CTranslate2 подтягивает
        # cuBLAS обычным LoadLibrary по имени - тот идёт по стандартному
        # порядку поиска, где эти каталоги не участвуют. Поэтому пути
        # дополнительно кладутся в PATH процесса.
        extra = os.pathsep.join(str(p) for p in registered)
        os.environ["PATH"] = extra + os.pathsep + os.environ.get("PATH", "")

    _done = True
    return registered


enable_cuda_dlls()
