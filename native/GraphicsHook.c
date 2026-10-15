#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <dxgi1_2.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include "MinHook.h"

// Shared-memory ABI v1. Only pixels for the exact requested output HWND are read.
typedef struct {
 uint32_t magic,pid; uint64_t window; uint32_t owner,stop,status,fps,max_width,width,height,stride,bytes;
 volatile LONG sequence; uint64_t captured; uint32_t error; BYTE reserved[184];
} Control;
_Static_assert(sizeof(Control)==256,"shared ABI");
#define CAPACITY (64u*1024u*1024u)
typedef HRESULT (STDMETHODCALLTYPE *PresentFn)(IDXGISwapChain*,UINT,UINT);
typedef HRESULT (STDMETHODCALLTYPE *Present1Fn)(IDXGISwapChain1*,UINT,UINT,const DXGI_PRESENT_PARAMETERS*);
static PresentFn original_present;
static Present1Fn original_present1;
static HINSTANCE own_module;
static Control* control;
static volatile LONG busy,inside,started;
static ID3D11Device* device;
static ID3D11DeviceContext* context;
static ID3D11Texture2D* stage[2];
static UINT tex_width,tex_height,tex_format,slot;
static BOOL copied[2];
static ULONGLONG last_tick;
static BYTE half_srgb[65536];
static void init_half_srgb(void) {
 // scRGB/linear FP16 -> bounded SDR sRGB. Values above SDR white clip;
 // this path does not claim HDR color fidelity. LUT keeps pow off Present.
 for(UINT bits=0;bits<65536;bits++) {
  UINT exponent=(bits>>10)&31,mantissa=bits&1023;float linear;
  if(bits&32768)linear=0;
  else if(exponent==31)linear=mantissa?0:1;
  else if(exponent==0)linear=mantissa/16777216.0f;
  else {union {UINT bits;float value;} value;value.bits=((exponent+112)<<23)|(mantissa<<13);linear=value.value;}
  if(linear>1)linear=1;
  float encoded=linear<=0.0031308f?12.92f*linear:1.055f*powf(linear,1.0f/2.4f)-0.055f;
  half_srgb[bits]=(BYTE)(encoded*255.0f+0.5f);
 }
}
static void clear_gpu(void) {
 for(int i=0;i<2;i++){if(stage[i])ID3D11Texture2D_Release(stage[i]);stage[i]=NULL;copied[i]=FALSE;}
 if(context)ID3D11DeviceContext_Release(context);context=NULL;
 if(device)ID3D11Device_Release(device);device=NULL;
 tex_width=tex_height=tex_format=slot=0;
}
static void capture(IDXGISwapChain* swap) {
 if(!control || control->stop || control->fps==0)return;
 DXGI_SWAP_CHAIN_DESC desc;if(FAILED(IDXGISwapChain_GetDesc(swap,&desc)) || desc.OutputWindow!=(HWND)(uintptr_t)control->window)return;
 ULONGLONG now=GetTickCount64();UINT fps=control->fps;if(fps>60)fps=60;
 if(now-last_tick<1000/fps || InterlockedCompareExchange(&busy,1,0)!=0)return;
 last_tick=now;
 ID3D11Texture2D* texture=NULL;
 HRESULT hr=IDXGISwapChain_GetBuffer(swap,0,&IID_ID3D11Texture2D,(void**)&texture);
 if(FAILED(hr)||!texture)goto done;
 D3D11_TEXTURE2D_DESC td;ID3D11Texture2D_GetDesc(texture,&td);
 *(volatile UINT*)((BYTE*)control+76)=td.Format;
 if(td.Width==0 || td.Height==0 || (uint64_t)td.Width*td.Height>16777216 || td.SampleDesc.Count!=1)goto release;
 if(td.Format!=DXGI_FORMAT_B8G8R8A8_UNORM && td.Format!=DXGI_FORMAT_R8G8B8A8_UNORM && td.Format!=DXGI_FORMAT_B8G8R8A8_UNORM_SRGB && td.Format!=DXGI_FORMAT_R8G8B8A8_UNORM_SRGB && td.Format!=DXGI_FORMAT_R16G16B16A16_FLOAT){control->error=10;goto release;}
 control->error=0;
 ID3D11Device* actual_device=NULL;ID3D11Texture2D_GetDevice(texture,&actual_device);
 BOOL changed=actual_device!=device;if(actual_device)ID3D11Device_Release(actual_device);
 if(!device || changed || td.Width!=tex_width || td.Height!=tex_height || td.Format!=tex_format) {
  clear_gpu();
  if(FAILED(IDXGISwapChain_GetDevice(swap,&IID_ID3D11Device,(void**)&device)))goto release;
  ID3D11Device_GetImmediateContext(device,&context);
  tex_width=td.Width;tex_height=td.Height;tex_format=td.Format;
  td.Usage=D3D11_USAGE_STAGING;td.BindFlags=0;td.CPUAccessFlags=D3D11_CPU_ACCESS_READ;td.MiscFlags=0;td.MipLevels=1;td.ArraySize=1;
  for(int i=0;i<2;i++)if(FAILED(ID3D11Device_CreateTexture2D(device,&td,NULL,&stage[i]))) {clear_gpu();goto release;}
 }
 UINT read_slot=slot^1;
 ID3D11DeviceContext_CopyResource(context,(ID3D11Resource*)stage[slot],(ID3D11Resource*)texture);copied[slot]=TRUE;slot=read_slot;
 if(!copied[read_slot])goto release;
 D3D11_MAPPED_SUBRESOURCE map;
 hr=ID3D11DeviceContext_Map(context,(ID3D11Resource*)stage[read_slot],0,D3D11_MAP_READ,D3D11_MAP_FLAG_DO_NOT_WAIT,&map);
 if(FAILED(hr))goto release;
 UINT width=control->max_width;if(width<320)width=320;if(width>1920)width=1920;if(width>tex_width)width=tex_width;
 UINT height=(UINT)((uint64_t)tex_height*width/tex_width);if(height==0)height=1;
 if((uint64_t)width*height*4<=CAPACITY) {
  InterlockedIncrement(&control->sequence);
  BYTE* dst=(BYTE*)control+256;
  BOOL rgba=(tex_format==DXGI_FORMAT_R8G8B8A8_UNORM || tex_format==DXGI_FORMAT_R8G8B8A8_UNORM_SRGB);
  BOOL fp16=tex_format==DXGI_FORMAT_R16G16B16A16_FLOAT;
  for(UINT y=0;y<height;y++) {
   BYTE* row=(BYTE*)map.pData+((uint64_t)y*tex_height/height)*map.RowPitch;
   for(UINT x=0;x<width;x++) {
    BYTE* src=row+((uint64_t)x*tex_width/width)*(fp16?8:4);BYTE* pixel=dst+((uint64_t)y*width+x)*4;
    if(fp16){const UINT16* half=(const UINT16*)src;pixel[0]=half_srgb[half[2]];pixel[1]=half_srgb[half[1]];pixel[2]=half_srgb[half[0]];}
    else {pixel[0]=src[rgba?2:0];pixel[1]=src[1];pixel[2]=src[rgba?0:2];}pixel[3]=255;
   }
  }
  control->width=width;control->height=height;control->stride=width*4;control->bytes=width*height*4;control->captured++;
  MemoryBarrier();InterlockedIncrement(&control->sequence);control->status=2;
 }
 ID3D11DeviceContext_Unmap(context,(ID3D11Resource*)stage[read_slot],0);
release: ID3D11Texture2D_Release(texture);
done: InterlockedExchange(&busy,0);
}
static HRESULT STDMETHODCALLTYPE present_hook(IDXGISwapChain* swap,UINT interval,UINT flags) {
 if(control)InterlockedIncrement((volatile LONG*)((BYTE*)control+72));
 InterlockedIncrement(&inside);capture(swap);HRESULT result=original_present(swap,interval,flags);InterlockedDecrement(&inside);return result;
}
static HRESULT STDMETHODCALLTYPE present1_hook(IDXGISwapChain1* swap,UINT interval,UINT flags,const DXGI_PRESENT_PARAMETERS* parameters) {
 if(control)InterlockedIncrement((volatile LONG*)((BYTE*)control+72));
 InterlockedIncrement(&inside);capture((IDXGISwapChain*)swap);HRESULT result=original_present1(swap,interval,flags,parameters);InterlockedDecrement(&inside);return result;
}
__declspec(dllexport) DWORD WINAPI CwbStart(const WCHAR* mapping_name) {
 if(InterlockedCompareExchange(&started,1,0)!=0)return 1;
 HANDLE mapping=OpenFileMappingW(FILE_MAP_ALL_ACCESS,FALSE,mapping_name),owner=NULL;
 HWND dummy=NULL;IDXGISwapChain* swap=NULL;ID3D11Device* test_device=NULL;ID3D11DeviceContext* test_context=NULL;
 void* target=NULL;void* target1=NULL;BOOL initialized=FALSE,enabled=FALSE,orphan=FALSE;
 if(!mapping)goto end;
 control=(Control*)MapViewOfFile(mapping,FILE_MAP_ALL_ACCESS,0,0,256+CAPACITY);
 if(!control || control->magic!=0x31425743 || control->pid!=GetCurrentProcessId())goto end;
 DWORD pid=0;GetWindowThreadProcessId((HWND)(uintptr_t)control->window,&pid);
 if(pid!=GetCurrentProcessId())goto end;
 owner=OpenProcess(SYNCHRONIZE,FALSE,control->owner);if(!owner)goto end;
 init_half_srgb();
 dummy=CreateWindowExW(0,L"STATIC",L"CWB D3D discovery",WS_POPUP,0,0,16,16,NULL,NULL,NULL,NULL);if(!dummy)goto end;
 DXGI_SWAP_CHAIN_DESC sd;ZeroMemory(&sd,sizeof(sd));sd.BufferCount=2;sd.BufferDesc.Width=16;sd.BufferDesc.Height=16;
 sd.BufferDesc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;sd.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;sd.OutputWindow=dummy;sd.SampleDesc.Count=1;sd.Windowed=TRUE;sd.SwapEffect=DXGI_SWAP_EFFECT_FLIP_DISCARD;
 if(FAILED(D3D11CreateDeviceAndSwapChain(NULL,D3D_DRIVER_TYPE_HARDWARE,NULL,0,NULL,0,D3D11_SDK_VERSION,&sd,&swap,&test_device,NULL,&test_context)))goto end;
 target=(*(void***)swap)[8];
 IDXGISwapChain1* swap1=NULL;
 if(SUCCEEDED(IDXGISwapChain_QueryInterface(swap,&IID_IDXGISwapChain1,(void**)&swap1))){target1=(*(void***)swap1)[22];IDXGISwapChain1_Release(swap1);}
 if(control->stop || WaitForSingleObject(owner,0)==WAIT_OBJECT_0)goto end;
 if(MH_Initialize()!=MH_OK)goto end;initialized=TRUE;
 if(MH_CreateHook(target,present_hook,(void**)&original_present)!=MH_OK)goto end;
 if(target1 && MH_CreateHook(target1,present1_hook,(void**)&original_present1)!=MH_OK)goto end;
 if(MH_EnableHook(MH_ALL_HOOKS)!=MH_OK)goto end;enabled=TRUE;control->status=1;
 while(!control->stop && WaitForSingleObject(owner,100)==WAIT_TIMEOUT) { DWORD current=0;GetWindowThreadProcessId((HWND)(uintptr_t)control->window,&current);if(current!=GetCurrentProcessId())break; }
end:
 if(enabled)MH_DisableHook(MH_ALL_HOOKS);
 while(InterlockedCompareExchange(&inside,0,0)!=0)Sleep(1);
 clear_gpu();if(initialized)MH_Uninitialize();
 if(test_context)ID3D11DeviceContext_Release(test_context);if(test_device)ID3D11Device_Release(test_device);if(swap)IDXGISwapChain_Release(swap);if(dummy)DestroyWindow(dummy);
 if(owner && WaitForSingleObject(owner,0)==WAIT_OBJECT_0)orphan=TRUE;
 if(control){control->status=3;UnmapViewOfFile(control);control=NULL;}
 if(mapping)CloseHandle(mapping);if(owner)CloseHandle(owner);
 InterlockedExchange(&started,0);
 if(orphan){Sleep(100);FreeLibraryAndExitThread(own_module,0);}
 return 0;
}
BOOL WINAPI DllMain(HINSTANCE module,DWORD reason,LPVOID unused){if(reason==DLL_PROCESS_ATTACH){own_module=module;DisableThreadLibraryCalls(module);}return TRUE;}
