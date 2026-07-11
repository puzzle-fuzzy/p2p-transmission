import viteSvg from './assets/vite.svg'

function App() {
  return (
    <div className="h-svh bg-[#2d2d2d] flex justify-center items-center">
      <div className="flex items-center">
        <div
          className="rounded-full w-20 h-20 border-2 border-[#2d2d2d] -ml-8 first:ml-0 flex justify-center items-center bg-[#3d3d3d] relative"
        >
          <img src={viteSvg} alt="" />
        </div>

        <div className="flex items-center gap-1.5 px-5">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div
              key={i}
              className="w-2 h-2 bg-amber-50/60 rounded-full"
              style={{
                animation: `dot-wave 1.4s ease-in-out ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </div>

        <div className="flex items-center">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="rounded-full w-20 h-20 border-2 border-[#2d2d2d] -ml-8 first:ml-0 flex justify-center items-center bg-[#3d3d3d] relative"
            >
              <img src={viteSvg} alt="" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default App
